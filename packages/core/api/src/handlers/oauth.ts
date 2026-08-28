// ---------------------------------------------------------------------------
// OAuth HTTP handlers — thin forwarders over `executor.oauth.*` (v2).
//
// `createClient` / `cancel` / `probe` are implemented in the SDK;
// `start` / `complete` are STUBBED there (milestone 2) and fail at runtime —
// the handlers are wired to call them so the surface is complete.
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { Effect, Option, Schema } from "effect";

import { runOAuthCallback, type PopupErrorMessage } from "../oauth-popup";
import {
  OAUTH_POPUP_MESSAGE_TYPE,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  OAuthState,
  WorkIdentityLinkError,
  type Connection,
  type ConnectResult,
  type OAuthCallbackCompletion,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { capture } from "../observability";
import { ExecutorService } from "../services";

const OAUTH_POPUP_CHANNEL = OAUTH_POPUP_MESSAGE_TYPE;

const decodeOAuthStartError = Schema.decodeUnknownOption(OAuthStartError);
const decodeOAuthCompleteError = Schema.decodeUnknownOption(OAuthCompleteError);
const decodeOAuthProbeError = Schema.decodeUnknownOption(OAuthProbeError);
const decodeOAuthSessionNotFoundError = Schema.decodeUnknownOption(OAuthSessionNotFoundError);
const decodeWorkIdentityLinkError = Schema.decodeUnknownOption(WorkIdentityLinkError);

const connectionToResponse = (c: Connection) => ({
  owner: c.owner,
  name: c.name,
  integration: c.integration,
  template: c.template,
  provider: c.provider,
  address: c.address,
  identityLabel: c.identityLabel ?? null,
  expiresAt: c.expiresAt ?? null,
  oauthClient: c.oauthClient ?? null,
  oauthClientOwner: c.oauthClientOwner ?? null,
  oauthScope: c.oauthScope ?? null,
  missingOAuthScopes: c.missingOAuthScopes ?? [],
});

const startResultToResponse = (result: ConnectResult) =>
  result.status === "connected"
    ? { status: "connected" as const, connection: connectionToResponse(result.connection) }
    : {
        status: "redirect" as const,
        authorizationUrl: result.authorizationUrl,
        state: result.state,
      };

/** What the popup posts back to the opener for each flow the shared callback can
 *  complete.
 *
 *  A connection keeps the historical shape verbatim — spread flat into the
 *  message — because openers already read its fields. A work identity is spread
 *  under its own key instead of flat: the two objects share field names
 *  (`owner`, for one) and a console must be able to tell which arrived by
 *  looking, not by guessing from overlapping keys. */
const callbackToPopupPayload = (completion: OAuthCallbackCompletion) =>
  completion.kind === "connection"
    ? connectionToResponse(completion.connection)
    : { workIdentity: completion.workIdentity };

const toPopupErrorMessage = (error: unknown): PopupErrorMessage => {
  const completeError = decodeOAuthCompleteError(error);
  if (Option.isSome(completeError))
    return {
      short: "Could not complete authentication",
      details: completeError.value.message,
    };

  const startError = decodeOAuthStartError(error);
  if (Option.isSome(startError))
    return {
      short: "Could not start authentication",
      details: startError.value.message,
    };

  const linkError = decodeWorkIdentityLinkError(error);
  if (Option.isSome(linkError))
    return {
      short: "Could not link your work identity",
      details: linkError.value.message,
    };

  const probeError = decodeOAuthProbeError(error);
  if (Option.isSome(probeError))
    return {
      short: "Could not discover authentication endpoint",
      details: probeError.value.message,
    };

  const sessionNotFound = decodeOAuthSessionNotFoundError(error);
  if (Option.isSome(sessionNotFound))
    return {
      short: "OAuth session expired or not found",
      details: `State: ${sessionNotFound.value.state}`,
    };

  return { short: "Authentication failed" };
};

export const OAuthHandlers = HttpApiBuilder.group(ExecutorApi, "oauth", (handlers) =>
  handlers
    .handle("createClient", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const client = yield* executor.oauth.createClient({
            owner: payload.owner,
            slug: payload.slug,
            authorizationUrl: payload.authorizationUrl,
            tokenUrl: payload.tokenUrl,
            grant: payload.grant,
            clientId: payload.clientId,
            clientSecret: payload.clientSecret,
            resource: payload.resource ?? null,
            origin: { kind: "manual", integration: payload.originIntegration ?? null },
          });
          return { client };
        }),
      ),
    )
    .handle("registerDynamic", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const client = yield* executor.oauth.registerDynamicClient({
            owner: payload.owner,
            slug: payload.slug,
            issuer: payload.issuer ?? null,
            registrationEndpoint: payload.registrationEndpoint,
            authorizationUrl: payload.authorizationUrl,
            tokenUrl: payload.tokenUrl,
            resource: payload.resource ?? null,
            scopes: payload.scopes,
            tokenEndpointAuthMethodsSupported: payload.tokenEndpointAuthMethodsSupported,
            clientName: payload.clientName,
            redirectUri: payload.redirectUri,
            originIntegration: payload.originIntegration ?? null,
          });
          return { client };
        }),
      ),
    )
    .handle("listClients", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.listClients();
        }),
      ),
    )
    .handle("removeClient", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.oauth.removeClient(payload.owner, path.slug);
          return { removed: true };
        }),
      ),
    )
    .handle("start", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const result = yield* executor.oauth.start({
            client: payload.client,
            clientOwner: payload.clientOwner,
            owner: payload.owner,
            name: payload.name,
            integration: payload.integration,
            template: payload.template,
            identityLabel: payload.identityLabel,
            newConnection: payload.newConnection,
            redirectUri: payload.redirectUri,
            // Enterprise-managed authorization inputs. Ignored by every other
            // grant, and REQUIRED by `id_jag` — the identity assertion is held
            // by the caller, never by the server.
            enterprise: payload.enterprise,
          });
          return startResultToResponse(result);
        }),
      ),
    )
    .handle("complete", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const connection = yield* executor.oauth.complete({
            state: payload.state,
            code: payload.code,
            callbackDomain: payload.callbackDomain ?? null,
          });
          return connectionToResponse(connection);
        }),
      ),
    )
    .handle("cancel", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.oauth.cancel(payload.state);
          return { cancelled: true };
        }),
      ),
    )
    .handle("probe", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.probe({ url: payload.url });
        }),
      ),
    )
    .handle("startWorkIdentityLink", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.startWorkIdentityLink({
            owner: payload.owner,
            idpClient: payload.idpClient,
            idpClientOwner: payload.idpClientOwner,
            scopes: payload.scopes,
            redirectUri: payload.redirectUri,
          });
        }),
      ),
    )
    .handle("completeWorkIdentityLink", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.completeWorkIdentityLink({
            state: payload.state,
            code: payload.code,
          });
        }),
      ),
    )
    .handle("workIdentityStatus", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.workIdentityStatus({
            owner: query.owner,
            idpClient: query.idpClient,
            idpClientOwner: query.idpClientOwner,
          });
        }),
      ),
    )
    .handle("unlinkWorkIdentity", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.oauth.unlinkWorkIdentity({
            owner: payload.owner,
            idpClient: payload.idpClient,
            idpClientOwner: payload.idpClientOwner,
          });
          return { unlinked: true };
        }),
      ),
    )
    .handle("callback", ({ query: urlParams }) =>
      // The callback always renders HTML, even on failure — the popup shows the
      // error + messages it back to the opener.
      //
      // BOTH browser flows land here: connecting an integration, and linking a
      // work identity. `completeCallback` reads the in-flight session to decide
      // which, so the route infers nothing from the URL. The popup payload stays
      // backward compatible — a connection is still spread flat, exactly as
      // before — and a link is spread as `{ workIdentity }`, which is how an
      // opener tells the two apart without the connection shape changing.
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const html = yield* runOAuthCallback({
            complete: ({ state, code, callbackDomain }) =>
              executor.oauth
                .completeCallback({
                  // `runOAuthCallback`'s `state` is a raw string from the URL;
                  // the SDK speaks the branded `OAuthState` (nominal brand).
                  state: OAuthState.make(state),
                  code: code ?? "",
                  callbackDomain,
                })
                .pipe(
                  Effect.map(callbackToPopupPayload),
                  Effect.tapError((cause: unknown) =>
                    Effect.logError("OAuth callback completion failed", cause),
                  ),
                ),
            urlParams,
            toErrorMessage: toPopupErrorMessage,
            channelName: OAUTH_POPUP_CHANNEL,
          });
          return HttpServerResponse.html(html);
        }),
      ),
    ),
);
