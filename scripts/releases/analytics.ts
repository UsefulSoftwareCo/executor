/** Release builds bake the PostHog ingestion key and host into launchers; other builds send nothing. */
import { Config, Effect } from "effect";

/** The baked analytics destination, or undefined for a build without one. */
export const releaseAnalytics = Effect.gen(function* () {
  const key = (yield* Config.String("EXECUTOR_POSTHOG_PUBLIC_KEY").pipe(
    Config.withDefault(""),
  )).trim();
  const host = (yield* Config.String("EXECUTOR_POSTHOG_HOST").pipe(Config.withDefault(""))).trim();
  if ((key === "") !== (host === ""))
    return yield* Effect.die(
      new Error("Set both EXECUTOR_POSTHOG_PUBLIC_KEY and EXECUTOR_POSTHOG_HOST, or neither."),
    );
  return key === "" ? undefined : { key, host };
});

/** Launcher lines that set the baked destination, or nothing for a build without one. */
export const launcherAnalytics = Effect.map(releaseAnalytics, (analytics) =>
  analytics === undefined
    ? ""
    : `process.env.EXECUTOR_POSTHOG_PUBLIC_KEY = ${JSON.stringify(analytics.key)};\nprocess.env.EXECUTOR_POSTHOG_HOST = ${JSON.stringify(analytics.host)};\n`,
);
