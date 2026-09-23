import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ProfileErrors } from "@executor-js/sdk/core";
/** Local browser handoff. These grants authorize one SDK connection, never a dashboard session. */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  AccountConnection,
  AccountConnectionId,
  Account,
  CreateAccountConnection,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  AppNotFound,
  AccountSelectionInvalid,
  AccountConnectionTargetChanged,
  AccountNotFound,
  ProviderNotFound,
  StorageError,
  CredentialsError,
  AccountFieldsInput,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  OAuthClientInput,
  OAuthClientSetup,
  OAuthStartResult,
  OAuthClientUnavailable,
  OAuthSetupFailed,
  OAuthCompletionFailed,
  HttpUrl,
} from "@executor-js/sdk";
import { AuthForbidden, PairingUnauthorized } from "./auth.ts";

/** A limited bearer value, redacted everywhere except its browser fragment and API submission. */
export const ConnectionGrant = Schema.Struct({
  connection: AccountConnectionId,
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
});
export type ConnectionGrant = typeof ConnectionGrant.Type;
/** The limited link is invalid; no general browser session is accepted as a substitute. */
export const ConnectionLinkRejected = UserFacingError.define({
  tag: "ConnectionLinkRejected",
  status: 401,
  title: "Connection link not valid",
  description: "This link cannot be used to connect an account.",
  recovery: {
    action: "Copy the fix prompt into your agent to create a new connection link.",
    instructions:
      "Create a new account connection request for the intended app requirement and provide its supported connection link. The rejected link is not usable. Do not reconstruct, log, or reuse its credential-bearing fragment.",
  },
});
/** Parsed ConnectionLinkRejected failure. */
export type ConnectionLinkRejected = typeof ConnectionLinkRejected.Type;
/** A host-generated URL, not part of the reusable SDK request model. */
export const AccountConnectionLink = Schema.Struct({
  connection: AccountConnectionId,
  url: Schema.RedactedFromValue(HttpUrl),
  expiresAt: Schema.Date,
});
/** Dashboard navigation retains the connection identity across OAuth redirects. */
export const ConnectionSignIn = Schema.Union([
  Schema.Struct({ ...OAuthStartResult.members[0].fields, connection: AccountConnectionId }),
  Schema.Struct({ ...OAuthStartResult.members[1].fields, connection: AccountConnectionId }),
]);

const errors = [
  ...ProfileErrors,
  ConnectionLinkRejected,
  AuthForbidden,
  StorageError,
  CredentialsError,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  AccountNotFound,
  ProviderNotFound,
] as const;
/** Browser submissions never accept an owner, provider, callback destination, or target account. */
export const AccountConnectApi = HttpApi.make("account-connect").add(
  HttpApiGroup.make("accountConnect")
    .add(
      HttpApiEndpoint.post("issue", "/account-connect/api/requests", {
        payload: CreateAccountConnection,
        success: AccountConnectionLink,
        error: [...errors, PairingUnauthorized, AppNotFound, AccountSelectionInvalid],
      }).annotate(
        OpenApi.Description,
        "Create a browser connection link. Pass target { app, requirement } to save and select the account automatically, or provider to save a standalone account. Optional account reconnects an existing account without changing its ID. Give the URL to the user to enter credentials or sign in with OAuth in Executor. Never ask for secrets in chat or search files for credentials. Check accountConnections.get after the user finishes.",
      ),
    )
    .add(
      HttpApiEndpoint.post("read", "/account-connect/api/read", {
        payload: ConnectionGrant,
        success: AccountConnection,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("cancel", "/account-connect/api/cancel", {
        payload: ConnectionGrant,
        success: AccountConnection,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("submit", "/account-connect/api/submit", {
        payload: Schema.Struct({
          ...ConnectionGrant.fields,
          method: Schema.NonEmptyString,
          label: Schema.NonEmptyString,
          fields: AccountFieldsInput,
        }),
        success: Account,
        error: [...errors, AccountFieldsInvalid, AuthMethodInvalid],
      }),
    )
    .add(
      HttpApiEndpoint.post("oauthSetup", "/account-connect/api/oauth/setup", {
        payload: Schema.Struct({ ...ConnectionGrant.fields, method: Schema.NonEmptyString }),
        success: OAuthClientSetup,
        error: [...errors, AuthMethodInvalid, OAuthSetupFailed],
      }),
    )
    .add(
      HttpApiEndpoint.post("startOAuth", "/account-connect/api/oauth/start", {
        payload: Schema.Struct({
          ...ConnectionGrant.fields,
          method: Schema.NonEmptyString,
          label: Schema.NonEmptyString,
          client: Schema.optional(OAuthClientInput),
        }),
        success: OAuthStartResult,
        error: [...errors, AuthMethodInvalid, OAuthClientUnavailable, OAuthSetupFailed],
      }),
    )
    .add(
      HttpApiEndpoint.post("completeOAuth", "/account-connect/api/oauth/complete", {
        payload: Schema.Struct({
          ...ConnectionGrant.fields,
          callbackUrl: Schema.RedactedFromValue(HttpUrl),
        }),
        success: Account,
        error: [...errors, OAuthCompletionFailed],
      }),
    ),
);
