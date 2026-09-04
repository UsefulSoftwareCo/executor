import { Effect, Schema } from "effect";

import type { FirstPartyOAuthClientConfig } from "@executor-js/sdk";

/** Server-side rollout for offering the built-in Google OAuth app. Configure
 *  the PostHog flag's runtime as "all": direct HTTP clients are not recognized
 *  as server SDKs. The caller identity still comes only from the server. */
export const GOOGLE_OAUTH_REVIEW_FLAG = "google-oauth-review";

const FlagsResponse = Schema.Struct({
  flags: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
});

/** Evaluate each listing against the authenticated user. Missing configuration,
 *  timeouts, and invalid responses withhold the app. No verdict is cached. */
export const makeGoogleOAuthListing =
  (config: {
    readonly projectKey: string | undefined;
    readonly host: string;
    readonly fetch: typeof globalThis.fetch;
  }): NonNullable<FirstPartyOAuthClientConfig["isListed"]> =>
  (context) =>
    Effect.gen(function* () {
      if (!config.projectKey || context.userId === null) return false;
      const response = yield* Effect.tryPromise(() =>
        config.fetch(`${config.host}/flags?v=2`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "executor-cloud" },
          body: JSON.stringify({
            api_key: config.projectKey,
            distinct_id: context.userId,
            // Supplied by the server so targeting needs no prior browser identify.
            person_properties: { executor_user_id: context.userId },
            groups: { organization: context.organizationId },
            flag_keys_to_evaluate: [GOOGLE_OAUTH_REVIEW_FLAG],
          }),
          signal: AbortSignal.timeout(1_000),
        }),
      );
      if (!response.ok) return false;
      const body: unknown = yield* Effect.tryPromise(() => response.json());
      const parsed = yield* Schema.decodeUnknownEffect(FlagsResponse)(body);
      return parsed.flags[GOOGLE_OAUTH_REVIEW_FLAG]?.enabled === true;
    }).pipe(Effect.catch(() => Effect.succeed(false)));
