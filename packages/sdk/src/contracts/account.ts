import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
/** Saved reusable accounts. Products decide access; pending setup lives in account-connection.ts. */
import { type Effect, Schema, SchemaGetter } from "effect";
import { StorageError, CredentialsError } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountInfo } from "apps/contracts";
import type { UiAccountProblem } from "apps/ui/contracts";
import type { App, AppAccounts } from "./apps.ts";
import { AccountId, AppId, JsonObject, OwnerId, ProviderId, WebhookId } from "./shared.ts";
import { AuthMethodInvalid, AuthMethodName, Provider, ProviderNotFound } from "./provider.ts";

/**
 * An independently owned account for one provider method. Several configured
 * apps can use this same ID. Metadata never includes tokens, submitted
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

/** One app that uses the account, and its latest check. */
export const AccountAppHealth = Schema.Struct({
  app: AppId,
  /** The app's active version defines a check for this account's provider. */
  checkable: Schema.Boolean,
  /**
   * The app's latest check. It is not `current` once the account's credentials or the app's
   * active version changed after it ran; recheck before relying on it.
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
 * Checks of an account by the apps that use it, as the product names them. An account no app uses
 * has no checks.
 * `info` is the upstream identity from the most recent passing check that reported one; it is
 * kept when later checks fail. It never replaces the account's own label.
 */
export const AccountHealth = Schema.Struct({
  account: AccountId,
  info: Schema.NullOr(AccountInfo),
  infoCheckedAt: Schema.NullOr(Schema.Date),
  /** A host removed this account's credentials after its service reported the account closed. */
  personalDataStatus: Schema.optionalKey(Schema.Literal("account_closed")),
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
 * Problems with the accounts chosen for an app page, from stored state. `found` holds the chosen
 * accounts the caller may use; any other chosen account was removed or is no longer shared.
 */
export const accountProblems = (
  app: App,
  chosen: AppAccounts,
  found: ReadonlyMap<string, { readonly account: Account; readonly health: AccountHealth }>,
): UiAccountProblem[] =>
  Object.entries(app.requirements.accounts).flatMap(([slot, requirement]): UiAccountProblem[] => {
    const provider = requirement.definition.name;
    const named = requirement.scope === "app" ? chosen.app : chosen.user;
    const selected = named !== undefined && Object.hasOwn(named, slot) ? named[slot] : undefined;
    if (selected === undefined || (requirement.cardinality === "one" && selected.length === 0))
      return [{ provider, reason: "missing" }];
    if (requirement.cardinality === "one" && selected.length > 1)
      return [{ provider, reason: "incompatible" }];
    return selected.flatMap((id): UiAccountProblem[] => {
      const entry = found.get(id);
      if (entry === undefined) return [{ provider, reason: "removed" }];
      if (entry.account.provider !== requirement.provider)
        return [{ provider, reason: "incompatible" }];
      const check = entry.health.apps.find((item) => item.app === app.id)?.check;
      return check === undefined || check === null || !check.current || check.status === "healthy"
        ? []
        : [{ provider, account: entry.account.label, reason: check.status }];
    });
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

/**
 * Host-only credential writes. Users and agents save credentials through an app's connection
 * request; products use these for accounts they provision themselves, such as their own API access.
 */
export const ManagedAccountInputs = {
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
  /** Replace every field of a secrets-method account, keeping its ID and selections. */
  replaceCredentials: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    fields: AccountFieldsInput,
  }),
};

/** Host-only: not part of the HTTP API or the Promise SDK. */
export interface ManagedAccounts {
  readonly add: (
    input: typeof ManagedAccountInputs.add.Type,
  ) => Effect.Effect<
    Account,
    StorageError | CredentialsError | ProviderNotFound | AuthMethodInvalid | AccountFieldsInvalid
  >;
  readonly replaceCredentials: (
    input: typeof ManagedAccountInputs.replaceCredentials.Type,
  ) => Effect.Effect<
    Account,
    | StorageError
    | CredentialsError
    | AccountNotFound
    | ProviderNotFound
    | AuthMethodInvalid
    | AccountFieldsInvalid
  >;
}

/** Canonical decoded inputs shared by HTTP contracts and the Promise facade. */
export const AccountInputs = {
  get: Schema.Struct({ account: AccountId, owner: Schema.optional(OwnerId) }),
  /** The owner bounds the read: provider definitions are shared, so only those its accounts use. */
  providers: Schema.Struct({ owner: OwnerId }),
  /** The owner bounds the read to one partition; there is no listing across owners. */
  list: Schema.Struct({ provider: Schema.optional(ProviderId), owner: OwnerId }),
  /** Change only the supplied fields. A null description removes it. */
  update: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  /** The apps the product links the account to; their checks are reported. */
  health: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    apps: Schema.Array(AppId),
  }),
  /** Every account of the owner, each with the apps the product links it to. */
  listHealth: Schema.Struct({
    owner: Schema.optional(OwnerId),
    links: Schema.Array(Schema.Struct({ account: AccountId, app: AppId })),
  }),
  /** Run the checks of these apps, the ones the product links the account to. */
  check: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    apps: Schema.Array(AppId),
  }),
};
const accountParams = { account: AccountInputs.get.fields.account };

/**
 * What deleting an account does at its service. `automatic`: Executor asks the service to revoke
 * the account's grant (RFC 7009) once the deletion commits, best effort. `manual`: the service
 * offers no revocation Executor can use, or the account has no OAuth grant, so access ends only
 * when the person removes it at the service.
 */
export const AccountRevocation = Schema.Struct({
  revocation: Schema.Literals(["automatic", "manual"]),
});
export type AccountRevocation = typeof AccountRevocation.Type;
const ownerQuery = { owner: AccountInputs.get.fields.owner };

/**
 * Owner filters are data predicates, not access enforcement. OAuth attempts
 * retain owner, label, provider, method, redirect URI and private state/PKCE
 * material on the host. Completion derives identity from that attempt, never
 * from callback-supplied owner/provider IDs.
 */
/** A subscription that still uses an account, and how far its lifecycle has got. */
export const AccountWebhookDependent = Schema.Struct({
  app: AppId,
  subscription: WebhookId,
  status: Schema.Literals(["pending", "setup-required", "active", "stopping", "disabled"]),
});
export type AccountWebhookDependent = typeof AccountWebhookDependent.Type;
/** The most subscriptions a refusal names. */
const maxNamedWebhookDependents = 10;
/**
 * Every subscription that holds the account, oldest ID first. The SDK lists them all as
 * `visible`; a product that limits who sees apps and subscriptions keeps the ones the caller may
 * see and counts the rest as `hidden`, so the refusal never names what the caller can't read.
 */
const Dependents = Schema.optionalKey(
  Schema.Struct({
    visible: Schema.Array(AccountWebhookDependent),
    hidden: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);
/**
 * Declared but not yet sent. Clients and Executor apps that hold an earlier document decode
 * `AccountWebhooksActive` as a closed object of `account` and `message`, so a new field would
 * turn this refusal into a generic failure for them. The subscriptions reach them through
 * `message`; a later release can send this field once cached documents have refreshed.
 */
const DependentsField = Dependents.pipe(
  Schema.decodeTo(Dependents, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.omit(),
  }),
);
const accountWebhooksActive = "Remove this account's webhook subscriptions before deleting it.";
/**
 * Keep the provider credentials while a subscription still uses them: its source account, and
 * while it is live, every account its registration ran with, which removing it needs.
 */
export const AccountWebhooksActive = ApiError.define({
  tag: "AccountWebhooksActive",
  status: 409,
  fields: { account: AccountId, dependents: DependentsField },
  message: ({ dependents }) => {
    if (dependents === undefined) return accountWebhooksActive;
    const { visible, hidden } = dependents;
    const named = visible
      .slice(0, maxNamedWebhookDependents)
      .map((item) => `${item.app}/${item.subscription} (${item.status})`)
      .join(", ");
    const more = visible.length - maxNamedWebhookDependents;
    const unseen = `${hidden} webhook ${hidden === 1 ? "subscription" : "subscriptions"} you can't see`;
    // Removal needs its actor or an app manager, who for a member's subscription must use its source.
    const removers =
      hidden === 1
        ? "Ask the person it runs as, or a manager of its app who can use its source account, to remove it."
        : "Ask the person each runs as, or a manager of its app who can use its source account, to remove them.";
    const parts =
      visible.length === 0
        ? [
            `${unseen} ${hidden === 1 ? "uses" : "use"} this account, so it can't be deleted.`,
            removers,
          ]
        : [
            `Webhook subscriptions still use this account, so it can't be deleted: ${named}${more > 0 ? ` and ${more} more` : ""}.`,
            "A subscription uses its source account and every account its registration ran with, so its source may be another account.",
            "Remove each live one with webhooks.remove, or unlink its source account from the app. For a disabled one, remove its webhook at the provider, then confirm with webhooks.confirmRemoval.",
            ...(hidden === 0
              ? []
              : [`${unseen} also ${hidden === 1 ? "uses" : "use"} it.`, removers]),
          ];
    return [...parts, "Then delete the account again."].join(" ");
  },
  recorded: () => accountWebhooksActive,
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
      "Rename a saved account or change its description. Only supplied fields change; a null description removes it. Agents read the label and description to choose between accounts. Its ID, credentials and app links stay the same.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/accounts/:account", {
      params: accountParams,
      query: ownerQuery,
      success: Schema.Struct({ account: AccountId }),
      error: [StorageError, AccountWebhooksActive, AccountWorkflowsActive],
    }).annotate(
      OpenApi.Description,
      "Delete a saved account and its local credentials. Inspect the apps it is linked to and confirm the intended account first. When the service supports revocation, also asks it to revoke the account's OAuth grant after the deletion, best effort; accounts.revocation reports whether it will. To stop using the account in only one app, unlink it from that app instead.",
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
      query: {
        ...ownerQuery,
        // A JSON query value preserves [] instead of dropping it as an absent query parameter.
        apps: Schema.fromJsonString(AccountInputs.health.fields.apps),
      },
      success: AccountHealth,
      error: [StorageError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Read the named apps' latest checks of an account and the identity the checks reported. Does not run a check.",
    ),
  )
  .add(
    HttpApiEndpoint.get("revocation", "/v1/accounts/:account/revocation", {
      params: accountParams,
      query: ownerQuery,
      success: AccountRevocation,
      error: [StorageError, CredentialsError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Report whether deleting an account also asks its service to revoke access, so a person can be told before they delete it. Does not contact the service.",
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
      "Run the provider checks of the named apps for this account, using its current credentials. Each app's check is a safe read defined in its source. Apps without a check stay unchecked. A passing check verifies only what that app's check tests.",
    ),
  )
  .add(
    HttpApiEndpoint.get("listHealth", "/v1/account-health", {
      query: {
        owner: Schema.optional(OwnerId),
        links: Schema.fromJsonString(AccountInputs.listHealth.fields.links),
      },
      success: Schema.Array(AccountHealth),
      error: StorageError,
    }).annotate(
      OpenApi.Description,
      "Read the latest checks and reported identity of every account, optionally for one owner, with the apps each is linked to. Does not run checks.",
    ),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/accounts", {
      query: AccountInputs.list.fields,
      success: Schema.Array(Account),
      error: StorageError,
    }).annotate(
      OpenApi.Description,
      "List one owner's saved account metadata, optionally filtered by provider. Credentials are never returned.",
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
    }).annotate(OpenApi.Description, "Provider definitions of an owner's saved accounts."),
  );
