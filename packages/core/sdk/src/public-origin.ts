// Shared resolution of a host's PUBLIC ORIGIN — the pinned base URL every host
// uses to build absolute outbound links (OAuth redirect_uri, MCP OAuth metadata,
// connect/approval URLs, email links). One implementation so the hosts don't
// drift (selfhost had the platform-detect chain; cloud/cloudflare did not).
//
// SECURITY: this is for SERVER-SIDE OUTBOUND urls, so the origin must come from
// a TRUSTED source — an operator-set env var, or a platform-injected deploy-time
// var — NEVER from the request `Host`/`X-Forwarded-Host` (host-header injection
// would let an attacker poison those links). The request origin may still be
// used for CSRF/origin validation and client-side display; that is each host's
// concern, not this module's.

/** A read-only environment record (process.env, or a Worker `env` binding). */
export type EnvRecord = Record<string, string | undefined>;

/**
 * The public origin a platform-as-a-service injects for this deployment, e.g.
 * Railway's `RAILWAY_PUBLIC_DOMAIN`. Ordering mirrors `@t3-oss/env-core`'s
 * `getPlatformOrigin` preset (MIT) — all platform-SET (not client-set) values,
 * so building absolute URLs from them is safe. Returns an origin (`https://host`,
 * no trailing slash) or undefined. The generic `PUBLIC_URL`/`APP_URL` from that
 * preset are deliberately omitted: `PUBLIC_URL` is a *path* in some toolchains
 * (CRA), not an origin. Cloudflare Workers receive none of these, so it returns
 * undefined there — expected; the Worker falls back to its own request origin.
 */
export const getPlatformOrigin = (env: EnvRecord): string | undefined => {
  const host =
    env.RAILWAY_PUBLIC_DOMAIN ??
    env.RENDER_EXTERNAL_HOSTNAME ??
    env.VERCEL_PROJECT_PRODUCTION_URL ??
    env.VERCEL_URL ??
    env.HEROKU_APP_DEFAULT_DOMAIN_NAME ??
    env.WEBSITE_HOSTNAME ?? // Azure App Service
    env.WEBSITE_DEFAULT_HOSTNAME ??
    (env.FLY_APP_NAME ? `${env.FLY_APP_NAME}.fly.dev` : undefined) ??
    (env.SITE_NAME ? `${env.SITE_NAME}.netlify.app` : undefined);
  const url =
    env.RENDER_EXTERNAL_URL ??
    env.DEPLOY_PRIME_URL ?? // Netlify (deploy/branch previews)
    env.URL ?? // Netlify (primary site URL)
    env.CF_PAGES_URL ??
    (host ? `https://${host}` : undefined);
  return url?.replace(/\/+$/, "");
};

/**
 * Resolve a deployment's pinned public origin: an explicit operator-set value
 * wins, else a platform-injected origin, else undefined (the caller supplies its
 * own fallback — a `localhost:PORT` for a Node host, a production constant or the
 * per-request origin for a Worker — and decides whether to warn).
 */
export const resolvePublicOrigin = (options: {
  readonly explicit?: string | undefined;
  readonly env: EnvRecord;
}): string | undefined => {
  const explicit = options.explicit?.trim();
  if (explicit) return explicit;
  return getPlatformOrigin(options.env);
};

/**
 * True unless this is explicitly local dev or a test run. A staging/demo deploy
 * often leaves `NODE_ENV` unset, and silently using a localhost fallback there is
 * the footgun we want surfaced — so warn by default.
 */
export const shouldWarnMissingPublicOrigin = (nodeEnv: string | undefined): boolean =>
  nodeEnv !== "development" && nodeEnv !== "test";

/** The one-time warning shown when a host falls back for its public origin. */
export const missingPublicOriginWarning = (options: {
  readonly varName: string;
  readonly fallback: string;
}): string =>
  `[executor] ${options.varName} is not set and no platform origin was detected; ` +
  `falling back to ${options.fallback}. OAuth redirects, MCP metadata, and connect ` +
  `links will use this — set ${options.varName} to your public origin ` +
  `(e.g. https://your-instance.example.com).`;
