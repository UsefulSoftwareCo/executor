const DEFAULT_SITE_ORIGIN = "https://v2.executor.sh";

/** Parse the public marketing origin supplied by the hosting composition root. */
export const parseSiteOrigin = (value: string | undefined): string => {
  const origin = value ?? DEFAULT_SITE_ORIGIN;
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
    throw new Error(
      "EXECUTOR_SITE_ORIGIN must be an HTTP(S) origin without a path, query, or fragment",
    );
  }

  return url.origin;
};

/** Public origin shared by the static marketing and documentation builds. */
export const siteOrigin = parseSiteOrigin(process.env.EXECUTOR_SITE_ORIGIN);
