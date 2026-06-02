// ---------------------------------------------------------------------------
// Shared OAuth HTTP handlers — thin forwarders over `executor.oauth.*`.
// Replaces the per-plugin copies that each had their own start / complete /
// callback handler.
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { Effect, Option, Predicate, Schema } from "effect";

import { runOAuthCallback, type PopupErrorMessage } from "../oauth-popup";
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
import { type ScopeId } from "@executor-js/sdk/shared";

import { ExecutorApi } from "../api";
import {
  type CallbackUrlParams,
  type CancelPayload,
  type CompletePayload,
  type ProbePayload,
  type StartPayload,
} from "../oauth/api";
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
      details: `Session id: ${sessionNotFound.value.sessionId}`,
    };

  return { short: "Authentication failed" };
};

const requireMatchingTokenScope = (
  routeScope: string,
  tokenScope: string,
): Effect.Effect<void, OAuthStartError> =>
  routeScope === tokenScope
    ? Effect.void
    : Effect.fail(
        new OAuthStartError({
          message: "OAuth token scope must match route scope",
        }),
      );

export const OAuthHandlers = HttpApiBuilder.group(ExecutorApi, "oauth", (handlers) =>
  handlers
    .handle(
      "probe",
      Effect.fn("oauth.probe")(function* (ctx: { payload: typeof ProbePayload.Type }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const headers = yield* resolveOAuthSecretBackedMap(
              executor,
              ctx.payload.headers,
              (message) => new OAuthProbeError({ message }),
            );
            const queryParams = yield* resolveOAuthSecretBackedMap(
              executor,
              ctx.payload.queryParams,
              (message) => new OAuthProbeError({ message }),
            );
            return yield* executor.oauth.probe({
              endpoint: ctx.payload.endpoint,
              headers,
              queryParams,
            });
          }),
        );
      }),
    )
    .handle(
      "start",
      Effect.fn("oauth.start")(function* (ctx: {
        params: { scopeId: typeof ScopeId.Type };
        payload: typeof StartPayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            yield* requireMatchingTokenScope(ctx.params.scopeId, ctx.payload.tokenScope);
            const executor = yield* ExecutorService;
            const headers = yield* resolveOAuthSecretBackedMap(
              executor,
              ctx.payload.headers,
              (message) => new OAuthStartError({ message }),
            );
            const queryParams = yield* resolveOAuthSecretBackedMap(
              executor,
              ctx.payload.queryParams,
              (message) => new OAuthStartError({ message }),
            );
            return yield* executor.oauth.start({
              endpoint: ctx.payload.endpoint,
              headers,
              queryParams,
              redirectUrl: ctx.payload.redirectUrl,
              connectionId: ctx.payload.connectionId,
              tokenScope: ctx.payload.tokenScope,
              strategy: ctx.payload.strategy as OAuthStrategy,
              pluginId: ctx.payload.pluginId,
              identityLabel: ctx.payload.identityLabel,
            });
          }),
        );
      }),
    )
    .handle(
      "complete",
      Effect.fn("oauth.complete")(function* (ctx: {
        params: { scopeId: typeof ScopeId.Type };
        payload: typeof CompletePayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.oauth.complete({
              state: ctx.payload.state,
              tokenScope: ctx.params.scopeId,
              code: ctx.payload.code,
              error: ctx.payload.error,
            });
          }),
        );
      }),
    )
    .handle(
      "cancel",
      Effect.fn("oauth.cancel")(function* (ctx: {
        params: { scopeId: typeof ScopeId.Type };
        payload: typeof CancelPayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            if (ctx.params.scopeId !== ctx.payload.tokenScope) {
              return yield* new OAuthSessionNotFoundError({
                sessionId: ctx.payload.sessionId,
              });
            }
            const executor = yield* ExecutorService;
            yield* executor.oauth.cancel(ctx.payload.sessionId, ctx.payload.tokenScope);
            return { cancelled: true };
          }),
        );
      }),
    )
    .handle(
      "callback",
      Effect.fn("oauth.callback")(function* (ctx: { query: typeof CallbackUrlParams.Type }) {
        // The callback always renders HTML, even on failure — the popup
        // shows the error + messages it back to the opener.
        return yield* capture(
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
                  ),
              urlParams: ctx.query,
              toErrorMessage: toPopupErrorMessage,
              channelName: OAUTH_POPUP_CHANNEL,
            });
            return HttpServerResponse.html(html);
          }),
        );
      }),
    ),
);
