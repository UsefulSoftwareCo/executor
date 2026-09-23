/** Saved reusable accounts. Products decide access; pending setup lives in account-connection.ts. */
import { Schema } from "effect";
import { StorageError, CredentialsError } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AccountId, JsonObject, OwnerId, ProviderId } from "./shared.ts";
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
  owner: OwnerId,
  createdAt: Schema.Date,
});

export type Account = typeof Account.Type;

/** Plain fields in public SDK calls; redacted immediately at the host boundary. */
export const AccountFieldsInput = Schema.RedactedFromValue(JsonObject);

/** No account matched the ID and any supplied owner constraint. */
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "AccountNotFound",
  { account: AccountId },
  {
    httpApiStatus: 404,
    description: "No account matches this id and any supplied owner constraint.",
  },
) {}

/** Submitted fields failed the declared method schema; values never enter this error. */
export class AccountFieldsInvalid extends Schema.TaggedError<AccountFieldsInvalid>()(
  "AccountFieldsInvalid",
  { provider: ProviderId, method: AuthMethodName },
  { httpApiStatus: 422, description: "Account fields did not match the selected secrets method." },
) {}

/** Canonical decoded inputs shared by HTTP contracts and the Promise facade. */
export const AccountInputs = {
  add: Schema.Struct({
    owner: OwnerId,
    provider: ProviderId,
    method: AuthMethodName,
    label: Schema.String,
    fields: AccountFieldsInput,
  }),
  get: Schema.Struct({ account: AccountId, owner: Schema.optional(OwnerId) }),
  list: Schema.Struct({ provider: Schema.optional(ProviderId), owner: Schema.optional(OwnerId) }),
  update: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    label: Schema.String,
  }),
  replaceCredentials: Schema.Struct({
    account: AccountId,
    owner: Schema.optional(OwnerId),
    fields: AccountFieldsInput,
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
export class AccountWebhooksActive extends Schema.TaggedError<AccountWebhooksActive>()(
  "AccountWebhooksActive",
  { account: AccountId },
  {
    httpApiStatus: 409,
    description: "Remove this account's webhook subscriptions before deleting it.",
  },
) {}

/** Active workflows retain their selected account identities until completion or termination. */
export class AccountWorkflowsActive extends Schema.TaggedError<AccountWorkflowsActive>()(
  "AccountWorkflowsActive",
  { account: AccountId },
  {
    httpApiStatus: 409,
    description: "Terminate this account's active workflow runs before deleting it.",
  },
) {}

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
      "Save an account using its provider reference and named secrets method. Fields must match the provider schema. Returns metadata only. For user-supplied credentials, use the product browser connection link so secrets never pass through the agent.",
    ),
  )
  .add(
    HttpApiEndpoint.patch("update", "/v1/accounts/:account", {
      params: accountParams,
      query: ownerQuery,
      payload: Schema.Struct({ label: AccountInputs.update.fields.label }),
      success: Account,
      error: [StorageError, AccountNotFound],
    }).annotate(
      OpenApi.Description,
      "Rename a saved account. Its ID, credentials and profile selections stay the same.",
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
      query: ownerQuery,
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
    HttpApiEndpoint.get("list", "/v1/accounts", {
      query: AccountInputs.list.fields,
      success: Schema.Array(Account),
      error: StorageError,
    }).annotate(
      OpenApi.Description,
      "List saved account metadata, optionally filtered by owner or provider. Credentials are never returned.",
    ),
  );
