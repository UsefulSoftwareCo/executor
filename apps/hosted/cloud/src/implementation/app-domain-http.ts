/** Observe provider quota responses without retaining credentials, URLs, or response bodies. */
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

/** The domain controller's real HTTP client, with bounded Cloudflare quota diagnostics. */
export const appDomainHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(
      HttpClient.tap((response) => {
        const remaining = /"default";\s*r=(\d+);\s*t=(\d+)/.exec(response.headers.ratelimit ?? "");
        const policy = /"default";\s*q=(\d+);\s*w=(\d+)/.exec(
          response.headers["ratelimit-policy"] ?? "",
        );
        const retry = response.headers["retry-after"];
        const ray = response.headers["cf-ray"];
        const quota = {
          status: response.status,
          ...(remaining === null
            ? {}
            : { remaining: Number(remaining[1]), resetSeconds: Number(remaining[2]) }),
          ...(policy === null
            ? {}
            : { limit: Number(policy[1]), windowSeconds: Number(policy[2]) }),
          ...(retry !== undefined && /^\d{1,8}$/.test(retry)
            ? { retryAfterSeconds: Number(retry) }
            : {}),
          ...(ray !== undefined && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/.test(ray) ? { ray } : {}),
        };
        return Effect.annotateCurrentSpan("app_domains.api_quota", quota).pipe(
          Effect.andThen(
            response.status === 429
              ? Effect.logWarning("Cloudflare app domain API throttled", quota)
              : Effect.void,
          ),
        );
      }),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));
