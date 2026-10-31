import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Pending account setup shared by browser forms, OAuth, and other SDK consumers. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountIdentity } from "./account-identity.ts";
import { Account, AccountNotFound, AccountFieldsInput, AccountFieldsInvalid } from "./account.ts";
import { AccountScope, AppNotFound, AccountSelectionInvalid } from "./apps.ts";
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
  OAuthSetupFailed,
  OAuthAdditionalConnection,
} from "./oauth.ts";
import { OAuthClientChoice, OAuthClientNotFound } from "./oauth-clients.ts";

/**
 * Target changes require a fresh connection; no credentials or selections are committed. This
 * includes a requirement whose scope changed since the connection started: one started for a
 * member's own account cannot become the app's, or the reverse.
 */
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
      "Read the current app version, account requirements, and intended account selection. Start a fresh connection against those requirements. Do not apply the old request to a changed target or overwrite a newer selection.",
  },
});
/** Parsed AccountConnectionTargetChanged failure. */
export type AccountConnectionTargetChanged = typeof AccountConnectionTargetChanged.Type;

/**
 * The product refused the connection's account for its app requirement under the completing
 * member's current access: a user requirement needs use of the app; an app requirement needs
 * management of the app and use of the connected account; a reconnect needs management of the
 * account it reconnects. No credentials or links are committed, and a reconnected
 * account keeps its saved credentials.
 */
export const AccountConnectionRefused = UserFacingError.define({
  tag: "AccountConnectionRefused",
  status: 403,
  fields: {
    app: AppId,
    requirement: Schema.String,
  },
  title: "Account not connected",
  description:
    "Your access doesn’t allow connecting this account for the app, so nothing was saved.",
  recovery: {
    action:
      "Check your access to the app and to the account’s destination, then start account setup again.",
    instructions:
      "The product refused this connection for its creator under current access. A member’s own account needs use of the app. An app’s account needs management of the app and use of the connected account, such as membership in a group it is shared with. Check the signed-in member’s access, choose a destination they can use or have someone with the needed access connect the account, then start a fresh connection. Do not bypass authorization or reuse this request.",
  },
});
/** Parsed AccountConnectionRefused failure. */
export type AccountConnectionRefused = typeof AccountConnectionRefused.Type;

/**
 * Why the connection's latest sign-in ended without an account: the same typed error its starter
 * or callback page received, with the stage, HTTP status and the service's own error it recorded,
 * or the product's refusal, or a changed target, that rolled back the account it signed in to.
 * Starting a new sign-in clears it. Connections store it in this error vocabulary; a stored failure
 * a later release can no longer read is left out rather than failing the connection.
 */
export const AccountConnectionFailure = Schema.Struct({
  at: Schema.Date,
  error: Schema.Union([
    OAuthSetupFailed,
    OAuthCompletionFailed,
    AccountConnectionRefused,
    AccountConnectionTargetChanged,
  ]),
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
/**
 * The app requirement an account is connected for. Completing the connection grants the hosts the
 * app declares, and the product links the account to the app in the same transaction.
 */
export const AccountConnectionTarget = Schema.Struct({
  app: AppId,
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
  target: AccountConnectionDestination,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  state: AccountConnectionState,
  sourceAccount: Schema.optionalKey(AccountId),
  additionalConnections: Schema.optionalKey(Schema.Array(OAuthAdditionalConnection)),
});
export type AccountConnection = typeof AccountConnection.Type;
/**
 * Every connection is for an app requirement, which supplies its provider and scope. A `scope`
 * names the one the caller started it for; the requirement must have it now. Without one, the
 * requirement's current scope is kept. Completing refuses a requirement whose scope changed since.
 * `account` reconnects that existing account instead of adding one; its owner and provider must
 * match.
 */
export const CreateAccountConnection = Schema.Struct({
  owner: OwnerId,
  target: Schema.Struct({
    ...AccountConnectionTarget.fields,
    scope: Schema.optional(AccountScope),
  }),
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
 * The connection names a stored client of its owner, the owner's automatic client, or a client
 * entered for it. Without one it signs in automatically; a reconnect keeps the stored client its
 * account signed in with while that client exists.
 */
/** A batch combines already authorized requests, without changing their owners, targets, or scopes. */
const oauthSelection = {
  sourceAccount: Schema.optional(Schema.NullOr(AccountId)),
  additionalConnections: Schema.optional(Schema.Array(OAuthAdditionalConnection)),
};
export const PlanConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  ...oauthSelection,
  method: AuthMethodName,
});
export const OAuthConnectionPlan = Schema.Struct({
  status: Schema.Literals(["reuse", "consent-required", "incompatible"]),
  reason: Schema.optionalKey(
    Schema.Literals(["identity", "placement", "client", "resource", "scopes", "busy"]),
  ),
  scopes: Schema.Array(Schema.String),
  missingScopes: Schema.Array(Schema.String),
  sourceAccount: Schema.optionalKey(AccountId),
  identity: Schema.optionalKey(AccountIdentity),
  targets: Schema.Array(
    Schema.Struct({ connection: AccountConnectionId, ...AccountConnectionDestination.fields }),
  ),
});
export type OAuthConnectionPlan = typeof OAuthConnectionPlan.Type;

export const StartConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  ...oauthSelection,
  method: AuthMethodName,
  label: Schema.optional(Schema.NonEmptyString),
  redirectUri: Schema.optional(HttpUrl),
  client: Schema.optional(OAuthClientChoice),
});
/** Reuse the selected account's actual grant, retaining its OAuth client. Hosts authorize both resources. */
export const ReuseConnectionOAuth = Schema.Struct({
  ...GetAccountConnection.fields,
  additionalConnections: Schema.optional(Schema.Array(OAuthAdditionalConnection)),
  account: AccountId,
  method: AuthMethodName,
  label: Schema.optional(Schema.NonEmptyString),
});
export const OAuthGrantReuseResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), account: Account }),
  Schema.Struct({
    status: Schema.Literal("consent-required"),
    reason: Schema.Literals(["identity", "placement", "client", "resource", "scopes", "busy"]),
  }),
]);
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
/**
 * The pending connection and the callback its sign-in sent as `redirect_uri`. A host that relays
 * the callback elsewhere rebuilds it on this URL before completing the sign-in.
 */
export const FoundConnectionOAuth = Schema.Struct({
  ...AccountConnection.fields,
  redirectUri: HttpUrl,
});
export type FoundConnectionOAuth = typeof FoundConnectionOAuth.Type;
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

const errors = [
  StorageError,
  AccountConnectionNotFound,
  ProviderNotFound,
  AccountNotFound,
] as const;
const saveErrors = [
  ...errors,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  AccountConnectionRefused,
  CredentialsError,
  AuthMethodInvalid,
  AccountFieldsInvalid,
] as const;
/** SDK account setup surface, independent of any dashboard, MCP transport or browser session. */
export const AccountConnectionsGroup = HttpApiGroup.make("accountConnections")
  .add(
    HttpApiEndpoint.post("planOAuth", "/v1/account-connections/oauth/plan", {
      payload: PlanConnectionOAuth,
      success: OAuthConnectionPlan,
      error: [
        ...errors,
        AccountConnectionClosed,
        AccountConnectionTargetChanged,
        AccountConnectionRefused,
        AuthMethodInvalid,
        CredentialsError,
        OAuthSetupFailed,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("reuseOAuth", "/v1/account-connections/oauth/reuse", {
      payload: ReuseConnectionOAuth,
      success: OAuthGrantReuseResult,
      error: [
        ...errors,
        AccountConnectionClosed,
        AccountConnectionTargetChanged,
        AccountConnectionRefused,
        CredentialsError,
        AuthMethodInvalid,
        OAuthSetupFailed,
      ],
    }).annotate(
      OpenApi.Description,
      "Use one verified account's existing OAuth grant for a pending connection. Keeps the source's exact client and resource. Completes only when one real grant covers the target scopes and both bindings have the same durable placement; otherwise returns consent-required without saving an account or link. Hosts must authorize use of the source and completion of the target.",
    ),
  )
  .add(
    HttpApiEndpoint.post("create", "/v1/account-connections", {
      payload: CreateAccountConnection,
      success: AccountConnection,
      error: [
        StorageError,
        ProviderNotFound,
        AccountNotFound,
        AccountConnectionNotFound,
        AppNotFound,
        AccountSelectionInvalid,
        AccountConnectionTargetChanged,
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
      "Check a connection request: pending, completed with account metadata, cancelled or expired. A pending or expired request whose latest OAuth sign-in failed has state.failure: the error the user saw, with its reason, cause (stage and HTTP status) and serviceError (the service's own error and description, or the bounded text of another error body). A rate_limited failure has retryAfter when the service said when to try again. A sign-in the product refused for the creator's current access records AccountConnectionRefused, and one whose app requirement changed, including its scope, records AccountConnectionTargetChanged; both need a new sign-in. Credentials are never returned. Do not busy-poll; check after the user finishes. Completed requests have already linked the account to the named app. A pending request whose app no longer requires its provider fails with AccountConnectionTargetChanged; request a new connection.",
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
      "Inspect a sign-in method's grant, scopes and whether a client can be created automatically, without registering a client, creating a connection, or starting authorization. Stored clients are listed by oauthClients.list. Hosts must authorize access to the owner and provider.",
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
        AccountConnectionRefused,
        CredentialsError,
        AuthMethodInvalid,
        OAuthClientUnavailable,
        OAuthClientNotFound,
        OAuthSetupFailed,
        OAuthCompletionFailed,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("findOAuth", "/v1/account-connections/oauth/find", {
      payload: FindConnectionOAuth,
      success: FoundConnectionOAuth,
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
        AccountConnectionRefused,
        CredentialsError,
        OAuthCompletionFailed,
      ],
    }),
  );
