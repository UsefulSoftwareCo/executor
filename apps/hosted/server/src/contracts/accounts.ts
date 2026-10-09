import { ProfileId, ProfileErrors } from "@executor-js/sdk/core";
import { RequiredAction } from "./authorization.ts";
import { requireAccount } from "./account-grants.ts";
import { ConnectionDestination } from "./resource-access.ts";
import { AccountWorkflowsActive } from "@executor-js/sdk/core";
import { AccountWebhooksActive } from "@executor-js/sdk/core";
/** Account metadata and connection flows for an authenticated organization. */
import {
  App,
  Provider,
  Account,
  AccountHealth,
  CredentialCheck,
  AccountId,
  AccountNotFound,
  AccountConnection,
  AccountConnectionId,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  AccountFieldsInput,
  AccountFieldsInvalid,
  AccountSelectionInvalid,
  AppId,
  AppNotFound,
  AuthMethodInvalid,
  CredentialsError,
  OAuthClientInput,
  OAuthClientUnavailable,
  OAuthClientSetup,
  ProviderId,
  AuthMethodName,
  OAuthCompletionFailed,
  OAuthSetupFailed,
  OAuthSignIn,
  OAuthStartResult,
  HttpUrl,
  ProviderNotFound,
  StorageError,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  OrganizationSlug,
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { AuthenticationUnavailable, RequireUser } from "./auth.ts";

const params = { organization: OrganizationReference };
const app = { ...params, app: AppId };
const connection = { ...params, connection: AccountConnectionId };
// Reading a connection also verifies ownership of its optional target app.
const connectionErrors = [
  ...ProfileErrors,
  StorageError,
  AccountConnectionNotFound,
  ProviderNotFound,
  AccountNotFound,
  AppNotFound,
  OrganizationForbidden,
] as const;
const completionErrors = [
  ...connectionErrors,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  CredentialsError,
] as const;
const prefix = "/api/organizations/:organization";
/** Account setup belongs in the browser, so agents receive an authenticated form link. */
export const BrowserAccountConnection = Schema.Struct({
  ...AccountConnection.fields,
  url: HttpUrl,
});
/** Display the exact registered callback when a host uses a separate OAuth relay. */
export const HostedAccountConnection = Schema.Struct({
  ...AccountConnection.fields,
  redirectUri: HttpUrl,
  /** The target app's check can validate credentials entered for this connection. */
  checkable: Schema.Boolean,
});
export type HostedAccountConnection = typeof HostedAccountConnection.Type;
/** Browser return context preserves the callback URL bound into the OAuth attempt. */
export const HostedOAuthSignIn = Schema.Struct({
  status: Schema.Literal("redirect"),
  ...OAuthSignIn.fields,
  redirectUri: HttpUrl,
});
export type HostedOAuthSignIn = typeof HostedOAuthSignIn.Type;
/** Immediate account completion needs no browser return context. */
export const HostedOAuthStartResult = Schema.Union([
  HostedOAuthSignIn,
  OAuthStartResult.members[1],
]);
export type HostedOAuthStartResult = typeof HostedOAuthStartResult.Type;
/** Safe metadata for the shared account detail view. */
export const HostedAccountDetail = Schema.Struct({
  account: Account,
  provider: Provider,
  apps: Schema.Array(App),
  /** Checks by the apps in `apps` only; reading it never runs a check. */
  health: AccountHealth,
  canManage: Schema.Boolean,
});
/** Credentials travel directly to the authorized host and never appear in successful responses. */
export const HostedAccounts = HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("get", `${prefix}/accounts/:account`, {
      params: { ...params, account: AccountId },
      success: HostedAccountDetail,
      error: [StorageError, AccountNotFound, ProviderNotFound],
    }).pipe(requireAccount.inspect),
  )
  .add(
    HttpApiEndpoint.post("checkCredentials", `${prefix}/apps/:app/credential-checks`, {
      params: app,
      payload: Schema.Struct({
        provider: ProviderId,
        method: AuthMethodName,
        fields: AccountFieldsInput,
      }),
      success: Schema.NullOr(CredentialCheck),
      error: [
        StorageError,
        AppNotFound,
        AuthMethodInvalid,
        AccountFieldsInvalid,
        OrganizationForbidden,
      ],
    }).annotate(RequiredAction, "run"),
  )
  .add(
    HttpApiEndpoint.post("check", `${prefix}/accounts/:account/health`, {
      params: { ...params, account: AccountId },
      success: AccountHealth,
      error: [StorageError, AccountNotFound, OrganizationForbidden],
    }).pipe(requireAccount.use),
  )
  .add(
    HttpApiEndpoint.delete("disconnect", `${prefix}/accounts/:account`, {
      params: { ...params, account: AccountId },
      success: Schema.Struct({ account: AccountId }),
      error: [
        StorageError,
        AccountWebhooksActive,
        AccountWorkflowsActive,
        AccountNotFound,
        OrganizationForbidden,
      ],
    }).pipe(requireAccount.delete),
  )
  .add(
    HttpApiEndpoint.patch("update", `${prefix}/accounts/:account`, {
      params: { ...params, account: AccountId },
      /** Only supplied fields change; a null description removes it. */
      payload: Schema.Struct({
        label: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
        description: Schema.optional(
          Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        ),
      }),
      success: Account,
      error: [StorageError, AccountNotFound, OrganizationForbidden],
    }).pipe(requireAccount.rename),
  )
  .add(
    HttpApiEndpoint.get("oauthSetup", `${prefix}/providers/:provider/oauth/:method/setup`, {
      params: { ...params, provider: ProviderId, method: AuthMethodName },
      success: OAuthClientSetup,
      error: [...connectionErrors, AuthMethodInvalid, CredentialsError, OAuthSetupFailed],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Check how an OAuth method will connect before the user signs in. scopes are the permissions sign-in will ask the provider for, and userScopes the ones Slack's user_scope asks for the user's own token; the connection form lists them too. Tell the user what will be requested before giving them the connection link. Without declared scopes, an MCP sign-in asks for the scopes the server's challenge names, which can be narrower than the ones it advertises. For other access, declare scopes on the app's provider and deploy it, then connect without account: declaring scopes changes the provider, so this creates a new account and selects it for the profile. The old account keeps its credentials and stays selected wherever else it is used. Pass account only to replace credentials for an unchanged provider.",
      ),
  )
  .add(
    HttpApiEndpoint.post("connect", `${prefix}/apps/:app/connections`, {
      params: app,
      payload: Schema.Struct({
        requirement: Schema.NonEmptyString,
        profile: ProfileId,
        destination: Schema.optional(ConnectionDestination),
        /** Replace this account's credentials instead of adding an account. */
        account: Schema.optional(AccountId),
      }),
      success: BrowserAccountConnection,
      error: [...connectionErrors, AccountSelectionInvalid],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Create a connection request and return the url of the browser form where the user enters credentials or signs in. For an OAuth method of the returned provider, oauthSetup with provider.id and the method name lists the permissions sign-in will request.",
      ),
  )
  .add(
    HttpApiEndpoint.get("connection", `${prefix}/connections/:connection`, {
      params: connection,
      success: HostedAccountConnection,
      error: [...connectionErrors, AccountConnectionTargetChanged],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Check a connection request: pending, completed with account metadata, cancelled or expired. A pending or expired request whose latest OAuth sign-in failed has state.failure: the error the user saw, with its reason, cause (stage and HTTP status) and serviceError (the service's own error and description, or the bounded text of another error body). A rate_limited failure has retryAfter when the service said when to try again. Check after the user finishes; do not busy-poll.",
      ),
  )
  .add(
    HttpApiEndpoint.post("submit", `${prefix}/connections/:connection/submit`, {
      params: connection,
      payload: Schema.Struct({
        method: Schema.NonEmptyString,
        label: Schema.optional(Schema.NonEmptyString),
        fields: AccountFieldsInput,
      }),
      success: Account,
      error: [...completionErrors, AuthMethodInvalid, AccountFieldsInvalid],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("startOAuth", `${prefix}/connections/:connection/oauth/start`, {
      params: connection,
      payload: Schema.Struct({
        method: Schema.NonEmptyString,
        label: Schema.optional(Schema.NonEmptyString),
        client: Schema.optional(OAuthClientInput),
      }),
      success: HostedOAuthStartResult,
      error: [...completionErrors, AuthMethodInvalid, OAuthClientUnavailable, OAuthSetupFailed],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("completeOAuth", `${prefix}/connections/:connection/oauth/complete`, {
      params: connection,
      payload: Schema.Struct({ callbackUrl: Schema.RedactedFromValue(HttpUrl) }),
      success: Account,
      error: [...completionErrors, OAuthCompletionFailed],
    }).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);

/** Where a provider's callback returns: the connection it completes and the page that follows. */
export const HostedOAuthCallback = Schema.Struct({
  /** Dashboard state is keyed by the organization's route reference, its slug. */
  organizationSlug: OrganizationSlug,
  connection: AccountConnectionId,
  app: Schema.NullOr(AppId),
  profile: Schema.optional(ProfileId),
  redirectUri: HttpUrl,
  reconnect: Schema.Boolean,
});
export type HostedOAuthCallback = typeof HostedOAuthCallback.Type;
/**
 * The callback's OAuth state finds its pending connection, so the sign-in can finish in any tab
 * or browser where the connection's creator is signed in. Completion repeats every check.
 */
export const HostedOAuthCallbacks = HttpApiGroup.make("oauthCallback")
  .add(
    HttpApiEndpoint.post("resolve", "/api/oauth/callback/resolve", {
      payload: Schema.Struct({ callbackUrl: Schema.RedactedFromValue(HttpUrl) }),
      success: HostedOAuthCallback,
      error: [
        ...connectionErrors,
        AccountConnectionTargetChanged,
        CredentialsError,
        OAuthCompletionFailed,
        AuthenticationUnavailable,
      ],
    }),
  )
  .middleware(RequireUser);
