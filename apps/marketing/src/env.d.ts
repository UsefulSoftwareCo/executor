/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_POSTHOG_KEY?: string;
  readonly PUBLIC_POSTHOG_HOST?: string;
  readonly PUBLIC_ANALYTICS_PATH?: string;
  readonly PUBLIC_EXECUTOR_API_ORIGIN: string;
  /** The `Domain` the site's visitor cookie shares with the browser origin; empty for host-only. */
  readonly PUBLIC_EXECUTOR_COOKIE_DOMAIN?: string;
}
