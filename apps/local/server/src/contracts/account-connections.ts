import { RequestRejection } from "@executor-js/sdk/core";
import {
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  InteractiveReconnectUnsupported,
} from "@executor-js/sdk";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Local browser handoff. These grants authorize one SDK connection, never a dashboard session. */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AccountConnection,
  AccountConnectionId,
  AccountConnectionTarget,
  Account,
  CreateAccountConnection,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  AppNotFound,
  AccountSelectionInvalid,
  AccountConnectionTargetChanged,
  AccountConnectionRefused,
  AccountNotFound,
  ProviderNotFound,
  StorageError,
  CredentialsError,
  AccountFieldsInput,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  OAuthClientSelection,
  OAuthClientNotFound,
  OAuthConnectOptions,
  OAuthStartResult,
  OAuthClientUnavailable,
  OAuthSetupFailed,
  OAuthCompletionFailed,
  HttpUrl,
  AccountId,
  AccountScope,
  AppId,
} from "@executor-js/sdk";
import { AuthForbidden, PairingUnauthorized } from "./auth.ts";
import { RequirementMismatch } from "./requirement-mismatch.ts";

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

/** Secrets entered on the link's form. */
export const ConnectionSubmission = Schema.Struct({
  ...ConnectionGrant.fields,
  method: Schema.NonEmptyString,
  label: Schema.optional(Schema.NonEmptyString),
  fields: AccountFieldsInput,
});
/** Provider consent started from the link's form, optionally with the client the person chose. */
export const ConnectionOAuthStart = Schema.Struct({
  ...ConnectionGrant.fields,
  method: Schema.NonEmptyString,
  label: Schema.optional(Schema.NonEmptyString),
  client: Schema.optional(OAuthClientSelection),
});

const errors = [
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  InteractiveReconnectUnsupported,
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
const issueErrors = [...errors, PairingUnauthorized, AppNotFound, AccountSelectionInvalid] as const;

/**
 * Create a browser connection link for one requirement of an app in the scope the route names, as
 * `appAccounts.appConnect` or `appAccounts.userConnect`: the agent-facing form of `issue`.
 */
const scopeConnect = <const S extends AccountScope>(scope: S) =>
  HttpApiEndpoint.post(
    `${scope}Connect`,
    `/account-connect/api/apps/:app/accounts/${scope}/:requirement/connections`,
    {
      params: { app: AppId, requirement: Schema.NonEmptyString },
      payload: Schema.Struct({
        /** Replace this account's credentials instead of adding an account. */
        account: Schema.optional(AccountId),
      }),
      success: AccountConnectionLink,
      error: [...issueErrors, RequirementMismatch],
    },
  ).annotate(
    OpenApi.Description,
    `${
      scope === "app"
        ? "Connect a new account for one of this app's own requirements, which every call and the app's background work use."
        : "Connect a new account of your own for one of this app's user requirements."
    } Returns the url of the browser form where the user enters credentials or signs in with OAuth; give the user that url. Completing it saves the account under the app's owner and links it to this requirement. Pass account to replace an existing account's credentials instead; it keeps its ID and links. Never ask for secrets in chat or search files for credentials. Check accountConnections.get after the user finishes.`,
  );

/** Browser submissions never accept an owner, provider, callback destination, or target account. */
const accountConnectApi = HttpApi.make("account-connect").add(
  HttpApiGroup.make("accountConnect")
    .add(
      HttpApiEndpoint.post("issue", "/account-connect/api/requests", {
        // The account takes the target app's owner; a caller's owner is ignored. The connection
        // keeps the requirement's scope when it is issued.
        payload: CreateAccountConnection.mapFields(({ owner: _owner, ...fields }) => ({
          ...fields,
          target: AccountConnectionTarget,
        })),
        success: AccountConnectionLink,
        error: issueErrors,
      }).annotate(
        OpenApi.Description,
        "Create a browser connection link for an app requirement: target { app, requirement }. Completing it saves the account under the app's owner and links it to the requirement, in the requirement's scope: for you for a user requirement, for every call for one of the app's own requirements. Optional account reconnects that existing account through the app without changing its ID. Give the URL to the user to enter credentials or sign in with OAuth in Executor. Never ask for secrets in chat or search files for credentials. Check accountConnections.get after the user finishes.",
      ),
    )
    .add(scopeConnect("app"))
    .add(scopeConnect("user"))
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
        payload: ConnectionSubmission,
        success: Account,
        error: [...errors, AccountConnectionRefused, AccountFieldsInvalid, AuthMethodInvalid],
      }),
    )
    .add(
      HttpApiEndpoint.post("oauthSetup", "/account-connect/api/oauth/setup", {
        payload: Schema.Struct({ ...ConnectionGrant.fields, method: Schema.NonEmptyString }),
        success: OAuthConnectOptions,
        error: [...errors, AuthMethodInvalid, OAuthSetupFailed],
      }),
    )
    .add(
      HttpApiEndpoint.post("startOAuth", "/account-connect/api/oauth/start", {
        payload: ConnectionOAuthStart,
        success: OAuthStartResult,
        error: [
          ...errors,
          AccountConnectionRefused,
          AuthMethodInvalid,
          OAuthClientUnavailable,
          OAuthClientNotFound,
          OAuthSetupFailed,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post("completeOAuth", "/account-connect/api/oauth/complete", {
        payload: Schema.Struct({
          ...ConnectionGrant.fields,
          callbackUrl: Schema.RedactedFromValue(HttpUrl),
        }),
        success: Account,
        error: [...errors, AccountConnectionRefused, OAuthCompletionFailed],
      }),
    ),
);
/** Every endpoint answers a request its schema rejects with `RequestInvalid`. */
export const AccountConnectApi = accountConnectApi.middleware(RequestRejection);
