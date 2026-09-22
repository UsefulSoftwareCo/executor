import { RequiredAction } from "./authorization.ts";
import { ConnectionDestination } from "./resource-access.ts";
import { AccountWorkflowsActive } from "@executor-js/sdk/core";
import { AccountWebhooksActive } from "@executor-js/sdk/core";
/** Account metadata and connection flows for an authenticated organization. */
import {
  App,
  Provider,
  Account,
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
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

const params = { organization: OrganizationReference };
const app = { ...params, app: AppId };
const connection = { ...params, connection: AccountConnectionId };
// Reading a connection also verifies ownership of its optional target app.
const connectionErrors = [
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
  canManage: Schema.Boolean,
});
/** Credentials travel directly to the authorized host and never appear in successful responses. */
export const HostedAccounts = HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("get", `${prefix}/accounts/:account`, {
      params: { ...params, account: AccountId },
      success: HostedAccountDetail,
      error: [StorageError, AccountNotFound, ProviderNotFound],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.post("reconnect", `${prefix}/accounts/:account/connections`, {
      params: { ...params, account: AccountId },
      success: AccountConnection,
      error: [...connectionErrors, AccountSelectionInvalid],
    }).annotate(RequiredAction, "manage"),
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
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.patch("rename", `${prefix}/accounts/:account`, {
      params: { ...params, account: AccountId },
      payload: Schema.Struct({
        label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
      }),
      success: Account,
      error: [StorageError, AccountNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("oauthSetup", `${prefix}/providers/:provider/oauth/:method/setup`, {
      params: { ...params, provider: ProviderId, method: AuthMethodName },
      success: OAuthClientSetup,
      error: [...connectionErrors, AuthMethodInvalid, CredentialsError, OAuthSetupFailed],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("connect", `${prefix}/apps/:app/connections`, {
      params: app,
      payload: Schema.Struct({
        requirement: Schema.NonEmptyString,
        destination: Schema.optional(ConnectionDestination),
      }),
      success: BrowserAccountConnection,
      error: [...connectionErrors, AccountSelectionInvalid],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("connection", `${prefix}/connections/:connection`, {
      params: connection,
      success: HostedAccountConnection,
      error: connectionErrors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("submit", `${prefix}/connections/:connection/submit`, {
      params: connection,
      payload: Schema.Struct({
        method: Schema.NonEmptyString,
        label: Schema.NonEmptyString,
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
        label: Schema.NonEmptyString,
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
