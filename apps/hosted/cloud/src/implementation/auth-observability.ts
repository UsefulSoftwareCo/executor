import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthPlugin } from "better-auth";
import { Effect, Exit, Option, Schema } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

const KnownError = Schema.Literals([
  "access_denied",
  "state_not_found",
  "state_mismatch",
  "state_expired",
  "invalid_callback_request",
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "nonce_binding_missing",
  "invalid_code",
  "unable_to_get_user_info",
  "no_callback_url",
  "unable_to_link_account",
  "account_not_linked",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "email_not_found",
  "email_not_verified",
  "unable_to_create_user",
  "unable_to_create_session",
  "signup_disabled",
]);
type Stage = "callback_validation" | "token_exchange" | "user_info" | "account_session";
interface Progress {
  stage: Stage;
  sessionCreated: boolean;
}
interface Observation {
  readonly provider: "github" | "google" | "other";
  readonly progress: Progress;
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
}

/** Observe social callbacks without exporting URLs, provider payloads or thrown errors. */
export const authObservability = () => {
  const requests = new AsyncLocalStorage<Observation>();
  const stage = async <A>(name: Stage, task: () => Promise<A>, accepted: (value: A) => boolean) => {
    const observation = requests.getStore();
    if (observation === undefined) return task();
    observation.progress.stage = name;
    const result = await observation.run(
      Effect.gen(function* () {
        // Better Auth owns these Promise errors. Keep the original rejection for it,
        // but never let a provider payload become an Effect span's error cause.
        const result = yield* Effect.promise(() =>
          Promise.resolve()
            .then(task)
            .then(
              (value) => ({ ok: true as const, value }),
              (cause: unknown) => ({ ok: false as const, cause }),
            ),
        );
        yield* Effect.annotateCurrentSpan({
          "auth.provider": observation.provider,
          "auth.stage": name,
          "executor.outcome": result.ok && accepted(result.value) ? "success" : "failed",
        });
        return result;
      }).pipe(Effect.withSpan(`auth.oauth.${name}`)),
    );
    if (!result.ok) throw result.cause;
    if (accepted(result.value))
      observation.progress.stage = name === "token_exchange" ? "user_info" : "account_session";
    return result.value;
  };
  const plugin: BetterAuthPlugin = {
    id: "executor-auth-observability",
    // Register last so emulator and other provider plugins have finished initialization.
    init: (context) => ({
      context: {
        socialProviders: context.socialProviders.map((provider) => ({
          ...provider,
          validateAuthorizationCode: (...args) =>
            stage(
              "token_exchange",
              () => provider.validateAuthorizationCode(...args),
              (value) => value != null,
            ),
          getUserInfo: (...args) =>
            stage(
              "user_info",
              () => provider.getUserInfo(...args),
              (value) => value?.user != null,
            ),
        })),
      },
    }),
  };
  return {
    plugin,
    sessionCreated: () => {
      const observation = requests.getStore();
      if (observation !== undefined) observation.progress.sessionCreated = true;
    },
    observe: <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "https://auth.invalid").pathname;
        const match = /^\/api\/auth\/(?:oauth2\/)?callback\/([^/]+)$/.exec(path);
        if (match === null) return yield* handler;
        const provider = match[1] === "github" || match[1] === "google" ? match[1] : "other";
        const requestSpan = yield* Effect.currentSpan.pipe(Effect.option);
        const record = (attributes: Record<string, string | number | boolean>) =>
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(attributes);
            // Retain HTTP 302 while marking the enclosing request's logical failure too.
            if (Option.isSome(requestSpan))
              for (const [key, value] of Object.entries(attributes))
                requestSpan.value.attribute(key, value);
            yield* Effect.logInfo("auth.oauth.callback.completed").pipe(
              Effect.annotateLogs(attributes),
            );
          });
        return yield* Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          const progress: Progress = { stage: "callback_validation", sessionCreated: false };
          const exit = yield* Effect.promise((signal) =>
            requests.run(
              {
                provider,
                progress,
                run: (effect) =>
                  Effect.runPromise(effect.pipe(Effect.provideContext(context)), { signal }),
              },
              () => Effect.runPromiseExit(handler.pipe(Effect.provideContext(context)), { signal }),
            ),
          );
          if (Exit.isFailure(exit)) {
            const attributes = {
              "auth.provider": provider,
              "auth.outcome": "failure",
              "auth.error_code": "internal_error",
              "auth.stage": progress.stage,
              "auth.session_created": progress.sessionCreated,
              "executor.outcome": "failed",
            };
            yield* record(attributes);
            return exit;
          }
          const response = exit.value;
          // Inspect only to project a bounded code. Never retain the URL or description.
          let error: string | null = null;
          const location = response.headers.location;
          if (location !== undefined) {
            try {
              error = new URL(location, "https://auth.invalid").searchParams.get("error");
            } catch {
              error = "invalid_redirect";
            }
          }
          const code =
            error === null
              ? response.status >= 400
                ? "http_error"
                : "none"
              : Option.getOrElse(
                  Schema.decodeUnknownOption(KnownError)(error),
                  () => "unrecognized_error" as const,
                );
          const outcome =
            code !== "none" ? "failure" : progress.sessionCreated ? "success" : "unconfirmed";
          const attributes = {
            "auth.provider": provider,
            "auth.outcome": outcome,
            "auth.error_code": code,
            "auth.stage": progress.stage,
            "auth.session_created": progress.sessionCreated,
            "http.response.status_code": response.status,
            "executor.outcome": outcome === "failure" ? "failed" : outcome,
          };
          yield* record(attributes);
          return exit;
        }).pipe(
          Effect.withSpan("auth.oauth.callback", { attributes: { "auth.provider": provider } }),
          Effect.flatten,
        );
      }),
  };
};
