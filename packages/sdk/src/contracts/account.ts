import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
/** Saved reusable accounts. Products decide access; pending setup lives in account-connection.ts. */
import { Schema } from "effect";
import { StorageError, CredentialsError } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountInfo } from "apps/contracts";
import type { UiAccountProblem } from "apps/ui/contracts";
import type { App, SelectedAccounts } from "./apps.ts";
import { AccountId, AppId, JsonObject, OwnerId, ProviderId } from "./shared.ts";
import { AuthMethodInvalid, AuthMethodName, Provider, ProviderNotFound } from "./provider.ts";

/**
 * An independently owned account for one provider method. Several configured
 * apps can select this same ID. Metadata never includes tokens, submitted
 * fields, OAuth client secrets, or refresh material.
 */
export const Account = Schema.Struct({
  id: AccountId,
  provider: ProviderId,
  method: AuthMethodName,
  label: Schema.String,
  /**
   * Free text for agents choosing between accounts, such as "reads only; use the sandbox account
   * for writes". Agents read it with the label. Null when the account has none.
   */
  description: Schema.NullOr(Schema.String),
  owner: OwnerId,
  createdAt: Schema.Date,
});

export type Account = typeof Account.Type;

/**
 * The outcome of one app's check of an account. Only `credentials_rejected` means the saved
 * credentials were refused; `check_failed` means the check could not verify the account, such as a
 * timeout or a failure in the app's check.
 */
export const AccountCheckStatus = Schema.Literals([
  "healthy",
  "credentials_rejected",
  "forbidden",
  "upstream_unavailable",
  "check_failed",
]);
export type AccountCheckStatus = typeof AccountCheckStatus.Type;

/** One app that selects the account, and its latest check. */
export const AccountAppHealth = Schema.Struct({
  app: AppId,
  /** The app's active deployment defines a check for this account's provider. */
  checkable: Schema.Boolean,
  /**
   * The app's latest check. It is not `current` once the account's credentials or the app's
   * active deployment changed after it ran; recheck before relying on it.
   */
  check: Schema.NullOr(
    Schema.Struct({
      status: AccountCheckStatus,
      checkedAt: Schema.Date,
      current: Schema.Boolean,
      /** Why the check failed, as the app or host explained it. Absent when it gave no reason. */
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type AccountAppHealth = typeof AccountAppHealth.Type;

/**
 * Checks of an account by the apps that select it. An account no app selects has no checks.
 * `info` is the upstream identity from the most recent passing check that reported one; it is
 * kept when later checks fail. It never replaces the account's own label.
 */
export const AccountHealth = Schema.Struct({
  account: AccountId,
  info: Schema.NullOr(AccountInfo),
  infoCheckedAt: Schema.NullOr(Schema.Date),
  apps: Schema.Array(AccountAppHealth),
});
export type AccountHealth = typeof AccountHealth.Type;

/** The app's current check found the account's credentials rejected; outdated checks make no claim. */
export const credentialsRejected = (health: AccountHealth, app: AppId) =>
  health.apps.some(
    (entry) =>
      entry.app === app &&
      entry.check?.current === true &&
      entry.check.status === "credentials_rejected",
  );

/**
 * Problems with a profile's selected accounts, from stored state. `found` holds the selected
 * accounts the caller may use; any other selected account was removed or is no longer shared.
 */
export const profileAccountProblems = (
  app: App,
  selection: SelectedAccounts,
  found: ReadonlyMap<string, { readonly account: Account; readonly health: AccountHealth }>,
): UiAccountProblem[] =>
  Object.entries(app.requirements.accounts).flatMap(([slot, requirement]): UiAccountProblem[] => {
    const provider = requirement.definition.name;
    const selected = selection[slot];
    if (selected === undefined) return [{ provider, reason: "missing" }];
    if ((requirement.cardinality === "one") !== (typeof selected === "string"))
      return [{ provider, reason: "incompatible" }];
    return (typeof selected === "string" ? [selected] : selected).flatMap(
      (id): UiAccountProblem[] => {
        const entry = found.get(id);
        if (entry === undefined) return [{ provider, reason: "removed" }];
        if (entry.account.provider !== requirement.provider)
          return [{ provider, reason: "incompatible" }];
        const check = entry.health.apps.find((item) => item.app === app.id)?.check;
        return check === undefined || check === null || !check.current || check.status === "healthy"
          ? []
          : [{ provider, account: entry.account.label, reason: check.status }];
      },
    );
  });

/** A check of credentials before they are saved; nothing is recorded. */
export const CredentialCheck = Schema.Struct({
  status: AccountCheckStatus,
  info: Schema.NullOr(AccountInfo),
  /**
   * The message of an error the app's check threw, bounded and with the checked credentials
   * replaced. Present only when a failing check threw one.
   */
  message: Schema.optionalKey(Schema.String),
});
export type CredentialCheck = typeof CredentialCheck.Type;

/** Plain fields in public SDK calls; redacted immediately at the host boundary. */
export const AccountFieldsInput = Schema.RedactedFromValue(JsonObject);

/** No account matched the ID and any supplied owner constraint. */
export const AccountNotFound = UserFacingError.define({
  tag: "AccountNotFound",
  status: 404,
  fields: { account: AccountId },
  title: "Account no longer available",
  description: "The requested account could not be found.",
  recovery: {
    action: "Close this form and select an available account, or start a new connection.",
    instructions:
      "Inspect the current app’s account selection and check whether the intended account still exists and is accessible. Guide selection of an available account or creation of a new connection. Do not silently substitute a different account.",
  },
});
/** Parsed AccountNotFound failure. */
export type AccountNotFound = typeof AccountNotFound.Type;

/** Submitted fields failed the declared method schema; values never enter this error. */
export const AccountFieldsInvalid = ApiError.define({
  tag: "AccountFieldsInvalid",
  status: 422,
  fields: { provider: ProviderId, method: AuthMethodName },
  message: ({ method }) =>
    `The submitted account fields do not match the “${method}” method's declared fields.`,
  recorded: () => "The submitted account fields do not match the method's declared fields",
});
export type AccountFieldsInvalid = typeof AccountFieldsInvalid.Type;

/** Canonical decoded inputs shared by HTTP contracts and the Promise facade. */
export const AccountInputs = {
  add: Schema.Struct({
    owner: OwnerId,
    provider: ProviderId,
    method: AuthMethodName,
    /** Without a label, the account is named when created and can be renamed once connected. */
    label: Schema.optional(Schema.String),
    /** Agent-visible notes about the account; omit for none. */
    description: Schema.optional(Schema.NullOr(Schema.String)),
    fields: AccountFieldsInput,
  }),
  get: Schema.Struct({ account: AccountId, owner: Schema.optional(OwnerId) }),
  /** `clear` drops the account from every profile selection, leaving those profiles pending. */
  remove: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    bindings: Schema.optional(Schema.Literals(["keep", "clear"])),
  }),
  providers: Schema.Struct({ owner: Schema.optional(OwnerId) }),
  list: Schema.Struct({ provider: Schema.optional(ProviderId), owner: Schema.optional(OwnerId) }),
  /** Change only the supplied fields. A null description removes it. */
  update: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  replaceCredentials: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    fields: AccountFieldsInput,
  }),
  listHealth: Schema.Struct({ owner: Schema.optional(OwnerId) }),
  check: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    /** Check only these apps; otherwise every app that selects the account and can check it. */
    apps: Schema.optional(Schema.Array(AppId)),
  }),
};
const accountParams = { account: AccountInputs.get.fields.account };
const ownerQuery = { owner: AccountInputs.get.fields.owner };

/**
 * Owner filters are data predicates, not access enforcement. OAuth attempts
 * retain owner, label, provider, method, redirect URI and private state/PKCE
 * material on the host. Completion derives identity from that attempt, never
 * from callback-supplied owner/provider IDs.
 */
/** Keep the provider credentials until subscriptions have completed their upstream cleanup. */
export const AccountWebhooksActive = ApiError.define({
  tag: "AccountWebhooksActive",
  status: 409,
  fields: { account: AccountId },
  message: "Remove this account's webhook subscriptions before deleting it.",
});
export type AccountWebhooksActive = typeof AccountWebhooksActive.Type;

/** Active workflows retain their selected account identities until completion or termination. */
export const AccountWorkflowsActive = ApiError.define({
  tag: "AccountWorkflowsActive",
  status: 409,
  fields: { account: AccountId },
  message: "Terminate this account's active workflow runs before deleting it.",
});
export type AccountWorkflowsActive = typeof AccountWorkflowsActive.Type;

/**
 * Saved sign-in state without refreshing tokens or contacting the provider. `reconnectAt` is the
 * moment a non-renewable grant expires. The fingerprint changes whenever stored credentials do.
 */
export const AccountSignIn = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("saved"),
    reconnectAt: Schema.NullOr(Schema.Date),
    credentialsFingerprint: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("reconnect"), credentialsFingerprint: Schema.String }),
  Schema.Struct({ state: Schema.Literal("unavailable"), credentialsFingerprint: Schema.String }),
]);
export type AccountSignIn = typeof AccountSignIn.Type;

export const AccountsGroup = HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.post("add", "/v1/accounts", {
      payload: AccountInputs.add,
      success: Account,
      error: [
        StorageError,
        CredentialsError,
        ProviderNotFound,
        AuthMethodInvalid,
        AccountFieldsInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Save an account using its provider reference and named secrets method. Fields must match the provider schema. An optional description tells agents what the account is for. Returns metadata only. For user-supplied credentials, use the product browser connection link so secrets never pass through the agent.",
    ),
  )
  .add(
    HttpApiEndpoint.patch("update", "/v1/accounts/:account", {
      params: accountParams,
      query: ownerQuery,
      payload: Schema.Struct({
        label: AccountInputs.update.fields.label,
        description: AccountInputs.update.fields.description,
      }),
      success: Account,
      error: [StorageError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Rename a saved account or change its description. Only supplied fields change; a null description removes it. Agents read the label and description to choose between accounts. Its ID, credentials and profile selections stay the same.",
    ),
  )
  .add(
    HttpApiEndpoint.put("replaceCredentials", "/v1/accounts/:account/credentials", {
      params: accountParams,
      query: ownerQuery,
      payload: Schema.Struct({ fields: AccountInputs.replaceCredentials.fields.fields }),
      success: Account,
      error: [
        StorageError,
        CredentialsError,
        AccountNotFound,
        ProviderNotFound,
        AuthMethodInvalid,
        AccountFieldsInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Replace all fields of a saved API-key account using its provider and method schema. All apps selecting this account use the new credentials. Returns metadata only. Use a browser connection link to collect user-supplied credentials.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/accounts/:account", {
      params: accountParams,
      query: { ...ownerQuery, bindings: AccountInputs.remove.fields.bindings },
      success: Schema.Struct({ account: AccountId }),
      error: [StorageError, AccountWebhooksActive, AccountWorkflowsActive],
    }).annotate(
      OpenApi.Description,
      "Delete a saved account and its local credentials. Inspect affected profile selections and confirm the intended account first. Does not revoke access at the provider. To stop using the account in only one app, update that profile selection instead.",
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/accounts/:account", {
      params: accountParams,
      query: ownerQuery,
      success: Account,
      error: [StorageError, AccountNotFound],
    }).annotate(OpenApi.Description, "Read saved account metadata without credentials."),
  )
  .add(
    HttpApiEndpoint.get("provider", "/v1/accounts/:account/provider", {
      params: { account: AccountId },
      query: { owner: Schema.optional(OwnerId) },
      success: Provider,
      error: [StorageError, AccountNotFound, ProviderNotFound],
    }).annotate(
      OpenApi.Description,
      "Read the provider definition and authentication methods for a saved account.",
    ),
  )
  .add(
    HttpApiEndpoint.get("health", "/v1/accounts/:account/health", {
      params: accountParams,
      query: ownerQuery,
      success: AccountHealth,
      error: [StorageError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Read each selecting app's latest check of an account and the identity the checks reported. Does not run a check.",
    ),
  )
  .add(
    HttpApiEndpoint.post("check", "/v1/accounts/:account/health", {
      params: accountParams,
      query: ownerQuery,
      payload: Schema.Struct({ apps: AccountInputs.check.fields.apps }),
      success: AccountHealth,
      error: [StorageError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Run the provider checks of the apps that select this account, using its current credentials. Each app's check is a safe read defined in its source. Apps without a check stay unchecked. A passing check verifies only what that app's check tests.",
    ),
  )
  .add(
    HttpApiEndpoint.get("listHealth", "/v1/account-health", {
      query: { owner: Schema.optional(OwnerId) },
      success: Schema.Array(AccountHealth),
      error: StorageError,
    }).annotate(
      OpenApi.Description,
      "Read the latest checks and reported identity of every account, optionally for one owner. Does not run checks.",
    ),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/accounts", {
      query: AccountInputs.list.fields,
      success: Schema.Array(Account),
      error: StorageError,
    }).annotate(
      OpenApi.Description,
      "List saved account metadata, optionally filtered by owner or provider. Credentials are never returned.",
    ),
  )
  .add(
    HttpApiEndpoint.get("signIn", "/v1/accounts/:account/sign-in", {
      params: accountParams,
      query: ownerQuery,
      success: AccountSignIn,
      error: [StorageError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Saved sign-in state for one account without refreshing tokens or contacting the provider.",
    ),
  )
  .add(
    HttpApiEndpoint.get("providers", "/v1/providers", {
      query: AccountInputs.providers.fields,
      success: Schema.Array(Provider),
      error: StorageError,
    }).annotate(
      OpenApi.Description,
      "Provider definitions known to this executor, optionally limited to those with saved accounts for an owner.",
    ),
  );
