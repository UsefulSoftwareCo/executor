import { ProfileId } from "./shared.ts";
import { ProfileErrors } from "./profiles.ts";
/** Pending account setup shared by browser forms, OAuth, and other SDK consumers. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Account, AccountNotFound, AccountFieldsInput, AccountFieldsInvalid } from "./account.ts";
import { AppNotFound, AccountSelectionInvalid } from "./apps.ts";
import { AuthMethodName, AuthMethodInvalid, Provider, ProviderNotFound } from "./provider.ts";
import {
  AccountConnectionId,
  AppId,
  AccountId,
  OwnerId,
  ProviderId,
  HttpUrl,
  StorageError,
  CredentialsError,
} from "./shared.ts";
import {
  OAuthClientUnavailable,
  OAuthClientSetup,
  CheckOAuthSetup,
  OAuthCompletionFailed,
  OAuthStartResult,
  OAuthClientInput,
  OAuthSetupFailed,
} from "./oauth.ts";

/** Public progress never contains submitted fields, grants, or OAuth protocol state. */
export const AccountConnectionState = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "cancelled", "expired"]) }),
  Schema.Struct({ status: Schema.Literal("completed"), account: Account }),
]);
/** A configured app requirement to fill when account setup finishes. */
export const AccountConnectionTarget = Schema.Struct({
  app: AppId,
  profile: Schema.optionalKey(ProfileId),
  requirement: Schema.NonEmptyString,
});
/** App name is captured for browser consent without exposing unrelated app configuration. */
export const AccountConnectionDestination = Schema.Struct({
  ...AccountConnectionTarget.fields,
  name: Schema.NonEmptyString,
});
/** Provider definitions drive the form. Hosts supply URLs and enforce access. */
export const AccountConnection = Schema.Struct({
  id: AccountConnectionId,
  owner: OwnerId,
  provider: Provider,
  reconnectAccount: Schema.NullOr(Account),
  target: Schema.NullOr(AccountConnectionDestination),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  state: AccountConnectionState,
});
export type AccountConnection = typeof AccountConnection.Type;
/** A reconnect binds the existing account, provider and owner at creation. */
export const CreateAccountConnection = Schema.Union([
  Schema.Struct({
    owner: OwnerId,
    provider: ProviderId,
    account: Schema.optional(AccountId),
    target: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    owner: OwnerId,
    target: AccountConnectionTarget,
    account: Schema.optional(AccountId),
    provider: Schema.optional(Schema.Never),
  }),
]);
/** Owner filters remain data predicates; the host must authorize each call. */
export const GetAccountConnection = Schema.Struct({
  connection: AccountConnectionId,
  owner: Schema.optional(OwnerId),
});
/** Save one set of fields. Successful retries return the same account. */
export const SubmitAccountConnection = Schema.Struct({
  ...GetAccountConnection.fields,
  method: AuthMethodName,
  label: Schema.NonEmptyString,
  fields: AccountFieldsInput,
});
/** OAuth setup is bound to the connection's owner and provider. */
export const StartConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  method: AuthMethodName,
  label: Schema.NonEmptyString,
  redirectUri: Schema.optional(HttpUrl),
  client: Schema.optional(OAuthClientInput),
});
/** Both request identity and OAuth state must match before exchanging a code. */
export const CompleteConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  callbackUrl: Schema.RedactedFromValue(HttpUrl),
});
/** Unknown IDs and mismatched owners have the same result. */
export class AccountConnectionNotFound extends Schema.TaggedError<AccountConnectionNotFound>()(
  "AccountConnectionNotFound",
  { connection: AccountConnectionId },
  { httpApiStatus: 404 },
) {}
/** Cancelled, expired, or superseded flows cannot save credentials. */
export class AccountConnectionClosed extends Schema.TaggedError<AccountConnectionClosed>()(
  "AccountConnectionClosed",
  { connection: AccountConnectionId },
  { httpApiStatus: 409 },
) {}

/** Target changes require a fresh connection; no credentials or selections are committed. */
export class AccountConnectionTargetChanged extends Schema.TaggedError<AccountConnectionTargetChanged>()(
  "AccountConnectionTargetChanged",
  {
    app: AppId,
    requirement: Schema.String,
  },
  {
    httpApiStatus: 409,
    description:
      "The app requirement or its selection changed. Start a new connection for this app.",
  },
) {}

const errors = [
  ...ProfileErrors,
  StorageError,
  AccountConnectionNotFound,
  ProviderNotFound,
  AccountNotFound,
] as const;
const saveErrors = [
  ...errors,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  CredentialsError,
  AuthMethodInvalid,
  AccountFieldsInvalid,
] as const;
/** SDK account setup surface, independent of any dashboard, MCP transport or browser session. */
export const AccountConnectionsGroup = HttpApiGroup.make("accountConnections")
  .add(
    HttpApiEndpoint.post("create", "/v1/account-connections", {
      payload: CreateAccountConnection,
      success: AccountConnection,
      error: [
        ...ProfileErrors,
        StorageError,
        ProviderNotFound,
        AccountNotFound,
        AccountConnectionNotFound,
        AppNotFound,
        AccountSelectionInvalid,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/account-connections/:connection", {
      params: { connection: AccountConnectionId },
      query: { owner: Schema.optional(OwnerId) },
      success: AccountConnection,
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Check a connection request: pending, completed with account metadata, cancelled or expired. Credentials are never returned. Do not busy-poll; check after the user finishes. Completed targeted requests have already selected the account for the app. Provider-only requests save standalone accounts.",
    ),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/v1/account-connections/:connection/cancel", {
      params: { connection: AccountConnectionId },
      query: { owner: Schema.optional(OwnerId) },
      success: AccountConnection,
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Cancel a pending connection request without changing saved accounts.",
    ),
  )
  .add(
    HttpApiEndpoint.post("submit", "/v1/account-connections/submit", {
      payload: SubmitAccountConnection,
      success: Account,
      error: saveErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("oauthSetup", "/v1/account-connections/oauth/setup", {
      payload: CheckOAuthSetup,
      success: OAuthClientSetup,
      error: [
        StorageError,
        ProviderNotFound,
        AuthMethodInvalid,
        CredentialsError,
        OAuthSetupFailed,
      ],
    }).annotate(
      OpenApi.Description,
      "Inspect OAuth client availability without registering a client, creating a connection, or starting authorization. Hosts must authorize access to the owner and provider.",
    ),
  )
  .add(
    HttpApiEndpoint.post("startOAuth", "/v1/account-connections/oauth/start", {
      payload: StartConnectionOAuth,
      success: OAuthStartResult,
      error: [
        ...errors,
        AccountConnectionClosed,
        AccountConnectionTargetChanged,
        CredentialsError,
        AuthMethodInvalid,
        OAuthClientUnavailable,
        OAuthSetupFailed,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth", "/v1/account-connections/oauth/complete", {
      payload: CompleteConnectionOAuth,
      success: Account,
      error: [
        ...errors,
        AccountConnectionClosed,
        AccountConnectionTargetChanged,
        CredentialsError,
        OAuthCompletionFailed,
      ],
    }),
  );
