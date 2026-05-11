// ---------------------------------------------------------------------------
// Shared OAuth HTTP handlers — thin forwarders over `executor.oauth.*`.
// Replaces the four per-plugin copies (mcp / openapi / google-discovery
// each had its own start / complete / callback handler).
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { Effect, Option, Predicate, Schema } from "effect";

import { runOAuthCallback } from "../oauth-popup";
import {
  OAUTH_POPUP_MESSAGE_TYPE,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  resolveSecretBackedMap,
  type Executor,
  type OAuthStrategy,
  type SecretBackedValue,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { capture } from "../observability";
import { ExecutorService } from "../services";

const OAUTH_POPUP_CHANNEL = OAUTH_POPUP_MESSAGE_TYPE;

const resolveOAuthSecretBackedMap = <E extends OAuthProbeError | OAuthStartError>(
  executor: Executor,
  values: Record<string, SecretBackedValue> | undefined,
  makeError: (message: string) => E,
) =>
  resolveSecretBackedMap({
    values,
    getSecret: executor.secrets.get,
    onMissing: (name) => makeError(`Secret not found for "${name}"`),
    onError: (_error, name) => makeError(`Secret not found for "${name}"`),
  }).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, "OAuthProbeError") || Predicate.isTagged(error, "OAuthStartError")
        ? (error as E)
        : makeError("Secret resolution failed"),
    ),
  );

const decodeOAuthStartError = Schema.decodeUnknownOption(OAuthStartError);
const decodeOAuthCompleteError = Schema.decodeUnknownOption(OAuthCompleteError);
const decodeOAuthProbeError = Schema.decodeUnknownOption(OAuthProbeError);
const decodeOAuthSessionNotFoundError = Schema.decodeUnknownOption(OAuthSessionNotFoundError);

const getOAuthErrorMessage = <A extends { readonly message: string }>(
  error: unknown,
  decode: (input: unknown) => Option.Option<A>,
): string | undefined =>
  Option.match(decode(error), {
    onNone: () => undefined,
    onSome: (oauthError) => oauthError.message,
  });

const toPopupErrorMessage = (error: unknown): string => {
  const message =
    getOAuthErrorMessage(error, decodeOAuthStartError) ??
    getOAuthErrorMessage(error, decodeOAuthCompleteError) ??
    getOAuthErrorMessage(error, decodeOAuthProbeError);
  if (message) return message;

  const sessionNotFound = decodeOAuthSessionNotFoundError(error);
  if (Option.isSome(sessionNotFound))
    return `OAuth session not found: ${sessionNotFound.value.sessionId}`;
  return "Authentication failed";
};

const requireMatchingTokenScope = (
  routeScope: string,
  tokenScope: string,
): Effect.Effect<void, OAuthStartError> =>
  routeScope === tokenScope
    ? Effect.void
    : Effect.fail(new OAuthStartError({ message: "OAuth token scope must match route scope" }));

export const OAuthHandlers = HttpApiBuilder.group(ExecutorApi, "oauth", (handlers) =>
  handlers
    .handle("probe", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const headers = yield* resolveOAuthSecretBackedMap(
            executor,
            payload.headers,
            (message) => new OAuthProbeError({ message }),
          );
          const queryParams = yield* resolveOAuthSecretBackedMap(
            executor,
            payload.queryParams,
            (message) => new OAuthProbeError({ message }),
          );
          return yield* executor.oauth.probe({
            endpoint: payload.endpoint,
            headers,
            queryParams,
          });
        }),
      ),
    )
    .handle("start", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          yield* requireMatchingTokenScope(path.scopeId, payload.tokenScope);
          const executor = yield* ExecutorService;
          const headers = yield* resolveOAuthSecretBackedMap(
            executor,
            payload.headers,
            (message) => new OAuthStartError({ message }),
          );
          const queryParams = yield* resolveOAuthSecretBackedMap(
            executor,
            payload.queryParams,
            (message) => new OAuthStartError({ message }),
          );
          return yield* executor.oauth.start({
            endpoint: payload.endpoint,
            headers,
            queryParams,
            redirectUrl: payload.redirectUrl,
            connectionId: payload.connectionId,
            tokenScope: payload.tokenScope,
            strategy: payload.strategy as OAuthStrategy,
            pluginId: payload.pluginId,
            identityLabel: payload.identityLabel,
          });
        }),
      ),
    )
    .handle("complete", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.complete({
            state: payload.state,
            tokenScope: path.scopeId,
            code: payload.code,
            error: payload.error,
          });
        }),
      ),
    )
    .handle("cancel", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          if (path.scopeId !== payload.tokenScope) {
            return yield* new OAuthSessionNotFoundError({ sessionId: payload.sessionId });
          }
          const executor = yield* ExecutorService;
          yield* executor.oauth.cancel(payload.sessionId, payload.tokenScope);
          return { cancelled: true };
        }),
      ),
    )
    .handle("callback", ({ query: urlParams }) =>
      // The callback always renders HTML, even on failure — the popup
      // shows the error + messages it back to the opener.
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const html = yield* runOAuthCallback({
            complete: ({ state, code, error }) =>
              executor.oauth
                .complete({
                  state,
                  code: code ?? undefined,
                  error: error ?? undefined,
                })
                .pipe(
                  Effect.tapError((cause) =>
                    Effect.logError("OAuth callback completion failed", cause),
                  ),
                  Effect.catchCause(() =>
                    Effect.fail(new OAuthCompleteError({ message: "Authentication failed" })),
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
