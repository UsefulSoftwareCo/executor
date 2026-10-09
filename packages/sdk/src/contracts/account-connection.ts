import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ProfileId } from "./shared.ts";
import { ProfileErrors } from "./profiles.ts";
/** Pending account setup shared by browser forms, OAuth, and other SDK consumers. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Account, AccountNotFound, AccountFieldsInput, AccountFieldsInvalid } from "./account.ts";
import { AppNotFound, AccountSelectionInvalid } from "./apps.ts";
import { AuthMethodName, AuthMethodInvalid, Provider, ProviderNotFound } from "./provider.ts";
import {
  AccountConnectionId,
  AppId,
  AccountId,
  OwnerId,
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

/**
 * Why the connection's latest sign-in ended without an account: the same typed error its starter
 * or callback page received, with the stage, HTTP status and the service's own error it recorded.
 * Starting a new sign-in clears it. Connections store it in this error vocabulary; a stored failure
 * a later release can no longer read is left out rather than failing the connection.
 */
export const AccountConnectionFailure = Schema.Struct({
  at: Schema.Date,
  error: Schema.Union([OAuthSetupFailed, OAuthCompletionFailed]),
});
export type AccountConnectionFailure = typeof AccountConnectionFailure.Type;
/** Public progress never contains submitted fields, grants, or OAuth protocol state. */
export const AccountConnectionState = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["pending", "expired"]),
    failure: Schema.optional(AccountConnectionFailure),
  }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({ status: Schema.Literal("completed"), account: Account }),
]);
export type AccountConnectionState = typeof AccountConnectionState.Type;
/** An app profile requirement to fill when account setup finishes. */
export const AccountConnectionTarget = Schema.Struct({
  app: AppId,
  profile: ProfileId,
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
/**
 * Every connection is for an app requirement, which supplies its provider. `account` reconnects
 * that existing account instead of adding one; its owner and provider must match.
 */
export const CreateAccountConnection = Schema.Struct({
  owner: OwnerId,
  target: AccountConnectionTarget,
  account: Schema.optional(AccountId),
});
/** Owner filters remain data predicates; the host must authorize each call. */
export const GetAccountConnection = Schema.Struct({
  connection: AccountConnectionId,
  owner: Schema.optional(OwnerId),
});
/** Save one set of fields. Successful retries return the same account. Without a label, the account is named when created. */
export const SubmitAccountConnection = Schema.Struct({
  ...GetAccountConnection.fields,
  method: AuthMethodName,
  label: Schema.optional(Schema.NonEmptyString),
  fields: AccountFieldsInput,
});
/**
 * OAuth setup is bound to the connection's owner and provider. Without a label, the account is
 * named when it is created, after sign-in, so it can be renamed once its identity is known.
 */
export const StartConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  method: AuthMethodName,
  label: Schema.optional(Schema.NonEmptyString),
  redirectUri: Schema.optional(HttpUrl),
  client: Schema.optional(OAuthClientInput),
});
/** Both request identity and OAuth state must match before exchanging a code. */
export const CompleteConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  callbackUrl: Schema.RedactedFromValue(HttpUrl),
});
/**
 * The callback's state identifies the pending sign-in, so a return that lost its browser context
 * can still find its connection. The host must authorize the returned owner and connection.
 */
export const FindConnectionOAuth = Schema.Struct({
  owner: Schema.optional(OwnerId),
  callbackUrl: Schema.RedactedFromValue(HttpUrl),
});
/** Unknown IDs and mismatched owners have the same result. */
export const AccountConnectionNotFound = UserFacingError.define({
  tag: "AccountConnectionNotFound",
  status: 404,
  fields: { connection: AccountConnectionId },
  title: "Connection no longer available",
  description: "This connection request could not be found.",
  recovery: {
    action:
      "Close this form and start account setup again. You can also copy the fix prompt into your agent to create a new connection link.",
    instructions:
      "Check whether the account connection request still exists. Start a new request for the current app requirement and provide its supported connection link. Do not reconstruct or reuse a missing request’s credentials or link.",
  },
});
/** Parsed AccountConnectionNotFound failure. */
export type AccountConnectionNotFound = typeof AccountConnectionNotFound.Type;
/** Cancelled, expired, or superseded flows cannot save credentials. */
export const AccountConnectionClosed = UserFacingError.define({
  tag: "AccountConnectionClosed",
  status: 409,
  fields: { connection: AccountConnectionId },
  title: "Connection has ended",
  description: "This request was completed, cancelled, or expired.",
  recovery: {
    action: "Close this form and start account setup again.",
    instructions:
      "Read the current connection status. If it completed, check whether the intended account is already connected. Otherwise start a fresh account setup request. Do not reuse a cancelled or expired request or create a duplicate account blindly.",
  },
});
/** Parsed AccountConnectionClosed failure. */
export type AccountConnectionClosed = typeof AccountConnectionClosed.Type;

/** Target changes require a fresh connection; no credentials or selections are committed. */
export const AccountConnectionTargetChanged = UserFacingError.define({
  tag: "AccountConnectionTargetChanged",
  status: 409,
  fields: {
    app: AppId,
    requirement: Schema.String,
  },
  title: "App account setup changed",
  description: "This connection no longer matches the app’s requirements.",
  recovery: {
    action: "Close this form and start account setup again.",
    instructions:
      "Read the current app deployment, account requirements, and intended account selection. Start a fresh connection against those requirements. Do not apply the old request to a changed target or overwrite a newer selection.",
  },
});
/** Parsed AccountConnectionTargetChanged failure. */
export type AccountConnectionTargetChanged = typeof AccountConnectionTargetChanged.Type;

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
      error: [...errors, AccountConnectionTargetChanged],
    }).annotate(
      OpenApi.Description,
      "Check a connection request: pending, completed with account metadata, cancelled or expired. A pending or expired request whose latest OAuth sign-in failed has state.failure: the error the user saw, with its reason, cause (stage and HTTP status) and serviceError (the service's own error and description, or the bounded text of another error body). A rate_limited failure has retryAfter when the service said when to try again. Credentials are never returned. Do not busy-poll; check after the user finishes. Completed requests have already selected the account for the named profile. A pending request whose app no longer requires its provider fails with AccountConnectionTargetChanged; request a new connection.",
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
    HttpApiEndpoint.post("findOAuth", "/v1/account-connections/oauth/find", {
      payload: FindConnectionOAuth,
      success: AccountConnection,
      error: [...errors, AccountConnectionTargetChanged, CredentialsError, OAuthCompletionFailed],
    }).annotate(
      OpenApi.Description,
      "Find the connection whose pending OAuth sign-in issued the callback's state, for example when the provider's link opened in another browser tab. Hosts must authorize the returned owner and connection before completing it.",
    ),
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
