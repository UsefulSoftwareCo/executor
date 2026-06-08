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
  type Connection,
  type ConnectResult,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { capture } from "../observability";
import { ExecutorService } from "../services";

const OAUTH_POPUP_CHANNEL = OAUTH_POPUP_MESSAGE_TYPE;

const decodeOAuthStartError = Schema.decodeUnknownOption(OAuthStartError);
const decodeOAuthCompleteError = Schema.decodeUnknownOption(OAuthCompleteError);
const decodeOAuthProbeError = Schema.decodeUnknownOption(OAuthProbeError);
const decodeOAuthSessionNotFoundError = Schema.decodeUnknownOption(OAuthSessionNotFoundError);

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
});

const startResultToResponse = (result: ConnectResult) =>
  result.status === "connected"
    ? { status: "connected" as const, connection: connectionToResponse(result.connection) }
    : {
        status: "redirect" as const,
        authorizationUrl: result.authorizationUrl,
        state: result.state,
      };

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
            registrationEndpoint: payload.registrationEndpoint,
            authorizationUrl: payload.authorizationUrl,
            tokenUrl: payload.tokenUrl,
            resource: payload.resource ?? null,
            scopes: payload.scopes,
            tokenEndpointAuthMethodsSupported: payload.tokenEndpointAuthMethodsSupported,
            clientName: payload.clientName,
            redirectUri: payload.redirectUri,
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
            redirectUri: payload.redirectUri,
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
    .handle("callback", ({ query: urlParams }) =>
      // The callback always renders HTML, even on failure — the popup shows the
      // error + messages it back to the opener.
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const html = yield* runOAuthCallback({
            complete: ({ state, code }) =>
              executor.oauth
                .complete({
                  // `runOAuthCallback`'s `state` is a raw string from the URL;
                  // the SDK speaks the branded `OAuthState` (nominal brand).
                  state: OAuthState.make(state),
                  code: code ?? "",
                })
                .pipe(
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
