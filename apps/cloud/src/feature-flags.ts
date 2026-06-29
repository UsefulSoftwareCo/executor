import { env } from "cloudflare:workers";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { DYNAMIC_UI_MCP_APPS_FEATURE_FLAG } from "@executor-js/plugin-dynamic-ui";

class PostHogFeatureFlagError extends Data.TaggedError("PostHogFeatureFlagError")<{
  readonly cause: unknown;
}> {}

const FeatureFlagsResponse = Schema.Struct({
  featureFlags: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeFeatureFlagsResponse = Schema.decodeUnknownOption(FeatureFlagsResponse);

export type FeatureFlagContext = {
  readonly distinctId?: string;
  readonly accountId?: string;
  readonly organizationId?: string;
  readonly groups?: Record<string, string>;
};

export type FeatureFlagsShape = {
  readonly isEnabled: (
    flag: string,
    context: FeatureFlagContext,
  ) => Effect.Effect<boolean, PostHogFeatureFlagError>;
};

export class CloudFeatureFlags extends Context.Service<CloudFeatureFlags, FeatureFlagsShape>()(
  "executor.cloud/FeatureFlags",
) {}

const postHogHost = (): string =>
  (env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");

const flagValueEnabled = (value: unknown): boolean =>
  value !== false && value !== null && value !== undefined;

const distinctIdFor = (context: FeatureFlagContext): string =>
  context.distinctId ?? context.accountId ?? context.organizationId ?? "executor-cloud";

const groupsFor = (context: FeatureFlagContext): Record<string, string> | undefined => {
  const groups = {
    ...(context.groups ?? {}),
    ...(context.organizationId ? { organization: context.organizationId } : {}),
  };
  return Object.keys(groups).length > 0 ? groups : undefined;
};

export const makePostHogFeatureFlags = (): FeatureFlagsShape => ({
  isEnabled: (flag, context) =>
    Effect.gen(function* () {
      const apiKey = env.VITE_PUBLIC_POSTHOG_KEY;
      if (!apiKey) return false;

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${postHogHost()}/decide/?v=3`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: apiKey,
              distinct_id: distinctIdFor(context),
              groups: groupsFor(context),
            }),
          }),
        catch: (cause) => new PostHogFeatureFlagError({ cause }),
      });

      if (!response.ok) return false;

      const raw = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new PostHogFeatureFlagError({ cause }),
      });
      const decoded = decodeFeatureFlagsResponse(raw);
      if (Option.isNone(decoded)) return false;
      return flagValueEnabled(decoded.value.featureFlags?.[flag]);
    }).pipe(Effect.withSpan("feature_flags.posthog.is_enabled", { attributes: { flag } })),
});

export const isGeneratedUiMcpAppsEnabled = (context: FeatureFlagContext) =>
  CloudFeatureFlags.asEffect().pipe(
    Effect.flatMap((featureFlags) =>
      featureFlags.isEnabled(DYNAMIC_UI_MCP_APPS_FEATURE_FLAG, context),
    ),
  );

export const PostHogFeatureFlags = Layer.succeed(CloudFeatureFlags, makePostHogFeatureFlags());
