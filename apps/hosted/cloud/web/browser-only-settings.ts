/**
 * Browser settings the deploy reads from the Sentry and PostHog stacks. Only the browser entry
 * uses them, so the server build leaves them out: the dashboard Worker's bytes then do not
 * depend on values that only a credentialed deploy can read, and
 * `bun run hosted:cloud:worker-sizes` builds the same Worker without them.
 */
export const browserOnlySettings = [
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_TUNNEL",
  "VITE_POSTHOG_KEY",
  "VITE_POSTHOG_PATH",
  "VITE_POSTHOG_HOST",
] as const;
