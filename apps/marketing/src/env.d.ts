/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_POSTHOG_KEY?: string;
  readonly PUBLIC_POSTHOG_HOST?: string;
  readonly PUBLIC_ANALYTICS_PATH?: string;
  readonly PUBLIC_EXECUTOR_API_ORIGIN: string;
}
