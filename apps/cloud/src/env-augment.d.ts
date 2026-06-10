// Augment the wrangler-generated `Cloudflare.Env` with secrets / vars set at
// deploy time (via `wrangler secret put`, dashboard, or `.dev.vars`) that
// don't show up in `wrangler types` output because they aren't declared in
// wrangler.jsonc, but are what `env.X` resolves to at runtime.
declare global {
  namespace Cloudflare {
    interface Env {
      // Observability
      AXIOM_TOKEN?: string;
      AXIOM_DATASET?: string;
      AXIOM_TRACES_URL?: string;
      AXIOM_TRACES_SAMPLE_RATIO?: string;
      SENTRY_DSN?: string;
      VITE_PUBLIC_SENTRY_DSN?: string;
      VITE_PUBLIC_POSTHOG_KEY?: string;
      VITE_PUBLIC_POSTHOG_HOST?: string;

      // Datastore. Prod uses HYPERDRIVE when the binding exists; direct
      // DATABASE_URL is only selected when explicitly requested for local/test.
      DATABASE_URL?: string;
      EXECUTOR_DIRECT_DATABASE_URL?: string;

      // SSRF / private-network egress guard. Unset in production -> the guard is
      // ON; the test workers set "true" so fixtures can reach localhost.
      ALLOW_LOCAL_NETWORK?: string;

      // Billing
      AUTUMN_SECRET_KEY?: string;
      /** Optional Autumn base-URL override (Autumn emulator in tests/dev). */
      AUTUMN_API_URL?: string;

      /** Optional WorkOS base-URL override (WorkOS emulator in tests/dev). */
      WORKOS_API_URL?: string;

      // MCP
      EXECUTOR_MCP_DEBUG?: string;
      MCP_AUTHKIT_DOMAIN?: string;
      MCP_RESOURCE_ORIGIN?: string;
      NODE_ENV?: string;

      // Shared with frontend
      VITE_PUBLIC_SITE_URL?: string;
    }
  }
}

export {};
