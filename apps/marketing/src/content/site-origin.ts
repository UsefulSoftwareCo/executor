const DEFAULT_SITE_ORIGIN = "https://executor.sh";

/** Parse a public origin supplied by the hosting composition root. */
export const parseSiteOrigin = (
  value: string | undefined,
  name = "EXECUTOR_SITE_ORIGIN",
  fallback = DEFAULT_SITE_ORIGIN,
): string => {
  const origin = value ?? fallback;
  const url = new URL(origin);

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without a path, query, or fragment`);
  }

  return url.origin;
};

/**
 * Public origin shared by the static marketing and documentation builds: where they are served
 * and what their canonical URLs name (`https://executor.sh` in production).
 */
export const siteOrigin = parseSiteOrigin(process.env.EXECUTOR_SITE_ORIGIN);

/**
 * Where people sign in and use the product (`https://app.executor.sh` in production). Sign-in
 * and sign-up links are absolute to it, because the site is served from another origin.
 */
export const appOrigin = parseSiteOrigin(
  process.env.EXECUTOR_APP_ORIGIN,
  "EXECUTOR_APP_ORIGIN",
  siteOrigin,
);

/**
 * Where the site's browser code reads the public app registry (`https://api.executor.sh` in
 * production). `/api/*` on the site's own origin belongs to v1's edge there, so these reads cross
 * origins; the registry's public GETs allow any origin.
 */
export const apiOrigin = parseSiteOrigin(
  process.env.EXECUTOR_API_ORIGIN,
  "EXECUTOR_API_ORIGIN",
  siteOrigin,
);

/** An absolute URL for a path on the product's browser origin, such as `/login`. */
export const appHref = (path: `/${string}`) => new URL(path, appOrigin).href;
