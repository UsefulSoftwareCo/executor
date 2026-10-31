import { InteractiveRetirementBusy, InteractiveRetirementFailed } from "@executor-js/sdk/core";
import { RequiredAction } from "./authorization.ts";
import { requireAccount } from "./account-grants.ts";
import { AccountWorkflowsActive } from "@executor-js/sdk/core";
import { AccountWebhooksActive } from "@executor-js/sdk/core";
/** Account metadata and connection flows for an authenticated organization. */
import {
  App,
  Provider,
  Account,
  AccountHealth,
  AccountRevocation,
  CredentialCheck,
  AccountId,
  AccountNotFound,
  AccountConnection,
  AccountConnectionId,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  AccountConnectionRefused,
  AccountConnectionTargetChanged,
  AccountFieldsInput,
  AccountFieldsInvalid,
  AppId,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AuthMethodInvalid,
  CredentialsError,
  OAuthClientNotFound,
  OAuthClientSelection,
  OAuthClientUnavailable,
  OAuthConnectOptions,
  ProviderId,
  AccountProvisioned,
  AuthMethodName,
  OAuthCompletionFailed,
  OAuthSetupFailed,
  OAuthSignIn,
  OAuthStartResult,
  HttpUrl,
  ProviderNotFound,
  StorageError,
  InteractiveConnectionFailed,
  InteractiveConnectionStatus,
} from "@executor-js/sdk/core";
import { InteractiveInstructions } from "apps/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  OrganizationSlug,
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { AuthenticationUnavailable, RequireUser } from "./auth.ts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";

/** The account is linked to apps for everyone; it cannot be deleted until it is unlinked. */
export const AccountLinkedToApp = UserFacingError.define({
  tag: "AccountLinkedToApp",
  status: 409,
  fields: { account: AccountId, apps: Schema.NonEmptyArray(AppId) },
  title: "This account is linked to an app for everyone",
  description:
    "An app uses this account for everyone who uses the app, so it can't be deleted while it is linked.",
  recovery: {
    action: "Ask someone who can edit each app to unlink the account, then delete it.",
    instructions:
      "Read the app accounts of each named app with appAccounts.appList and unlink this account with appAccounts.appUnlink, or ask someone who can edit the app to. Link a replacement first if the app still needs one. Then delete the account.",
  },
});
/** Parsed AccountLinkedToApp failure. */
export type AccountLinkedToApp = typeof AccountLinkedToApp.Type;

const params = { organization: OrganizationReference };
const app = { ...params, app: AppId };
const connection = { ...params, connection: AccountConnectionId };
// Reading a connection also verifies ownership of its optional target app.
const connectionErrors = [
  AccountProvisioned,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  StorageError,
  AccountConnectionNotFound,
  ProviderNotFound,
  AccountNotFound,
  AppNotFound,
  OrganizationForbidden,
] as const;
const completionErrors = [
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  ...connectionErrors,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  AccountConnectionRefused,
  CredentialsError,
] as const;
const prefix = "/api/organizations/:organization";
/**
 * Account setup belongs in the browser, so agents receive an authenticated form link, and the
 * callback to register when the service needs the user's own OAuth client.
 */
export const BrowserAccountConnection = Schema.Struct({
  ...AccountConnection.fields,
  url: HttpUrl,
  redirectUri: HttpUrl,
});
/**
 * Reading a connection returns the same form link as creating it, so an agent can hand it over
 * again, and the exact registered callback when a host uses a separate OAuth relay.
 */
export const HostedAccountConnection = Schema.Struct({
  ...AccountConnection.fields,
  url: HttpUrl,
  redirectUri: HttpUrl,
  /** The target app's check can validate credentials entered for this connection. */
  checkable: Schema.Boolean,
});
export type HostedAccountConnection = typeof HostedAccountConnection.Type;
/** Browser return context preserves the callback URL bound into the OAuth attempt. */
export const HostedOAuthSignIn = Schema.Struct({
  status: Schema.Literal("redirect"),
  ...OAuthSignIn.fields,
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
  /** Whether deleting the account also asks its service to revoke access. */
  revocation: AccountRevocation.fields.revocation,
  canManage: Schema.Boolean,
  canReconnect: Schema.Boolean,
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
        AccountLinkedToApp,
        InteractiveRetirementBusy,
        InteractiveRetirementFailed,
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
      success: OAuthConnectOptions,
      error: [...connectionErrors, AuthMethodInvalid, CredentialsError, OAuthSetupFailed],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Check how an OAuth method will connect before the user signs in. scopes are the permissions sign-in will ask the provider for, and userScopes the ones Slack's user_scope asks for the user's own token; the connection form lists them too. Tell the user what will be requested before giving them the connection link. Without declared scopes, an MCP sign-in asks for the scopes the server's challenge names, which can be narrower than the ones it advertises. For other access, declare scopes on the app's provider and deploy it, then connect without account (appAccounts.userConnect or appAccounts.appConnect): declaring scopes changes the provider, so this creates a new account and links it to the requirement. The old account keeps its credentials and stays linked wherever else it is used. Pass account only to replace credentials for an unchanged provider. clients lists the registered OAuth clients the caller may connect with; clients outside the caller's audience are not listed.",
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
        /**
         * A registered client the caller may use, the organization's automatic client, or one
         * entered for this account alone. Omitted, a new account uses the automatic client and a
         * reconnect keeps the client its account signed in with.
         */
        client: Schema.optional(OAuthClientSelection),
      }),
      success: HostedOAuthStartResult,
      error: [
        ...completionErrors,
        AuthMethodInvalid,
        OAuthClientUnavailable,
        OAuthClientNotFound,
        OAuthSetupFailed,
      ],
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
  .add(
    HttpApiEndpoint.post(
      "startInteractive",
      `${prefix}/connections/:connection/interactive/start`,
      {
        params: connection,
        payload: Schema.Struct({ method: AuthMethodName }),
        success: InteractiveInstructions,
        error: [
          ...connectionErrors,
          AppNotDeployed,
          AccountRequired,
          InteractiveConnectionFailed,
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
        ],
      },
    ).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get(
      "interactiveStatus",
      `${prefix}/connections/:connection/interactive/status`,
      {
        params: connection,
        success: InteractiveConnectionStatus,
        error: [
          ...connectionErrors,
          AppNotDeployed,
          AccountRequired,
          InteractiveConnectionFailed,
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
        ],
      },
    ).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post(
      "submitInteractive",
      `${prefix}/connections/:connection/interactive/submit`,
      {
        params: connection,
        payload: Schema.Struct({ value: Schema.String.check(Schema.isMaxLength(16384)) }),
        success: InteractiveConnectionStatus,
        error: [
          ...connectionErrors,
          AppNotDeployed,
          AccountRequired,
          InteractiveConnectionFailed,
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
        ],
      },
    ).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post(
      "cancelInteractive",
      `${prefix}/connections/:connection/interactive/cancel`,
      {
        params: connection,
        success: Schema.Void,
        error: [
          ...connectionErrors,
          AppNotDeployed,
          AccountRequired,
          InteractiveConnectionFailed,
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
        ],
      },
    ).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);

/** Where a provider's callback returns: the connection it completes and the page that follows. */
export const HostedOAuthCallback = Schema.Struct({
  /** Dashboard state is keyed by the organization's route reference, its slug. */
  organizationSlug: OrganizationSlug,
  connection: AccountConnectionId,
  app: AppId,
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
