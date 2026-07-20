// Better Auth rejects any request whose Origin isn't the configured webBaseUrl
// with a bare 403 "Invalid origin". On a self-host deploy that almost always
// means the instance's public URL wasn't detected or configured — so we replace
// that dead-end with a message naming the exact fix (the URL to set). The error
// `code` is preserved so programmatic clients are unaffected; only the
// human-facing `message` changes.

const INVALID_ORIGIN = /invalid origin/i;

/** The origin a request came from: the browser `Origin`, else the proxy host. */
export const originOf = (request: Request): string | null => {
  const explicit = request.headers.get("origin");
  if (explicit) return explicit;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return null;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
};

/** Actionable replacement for "Invalid origin". */
export const invalidOriginHelp = (requestOrigin: string | null, webBaseUrl: string): string =>
  requestOrigin
    ? `This Executor instance is configured for ${webBaseUrl}, but you're connecting from ${requestOrigin}. ` +
      `Set EXECUTOR_WEB_BASE_URL to ${requestOrigin} if it should be the canonical public URL, or add it to ` +
      `EXECUTOR_TRUSTED_ORIGINS if it is an intentional browser alias, then restart the server. ` +
      `(Railway, Render, Fly, Vercel, and similar hosts detect the canonical public URL automatically.)`
    : `This Executor instance is configured for ${webBaseUrl}. If you're reaching it at a different address, ` +
      `set EXECUTOR_WEB_BASE_URL to that canonical address or add the alias to EXECUTOR_TRUSTED_ORIGINS, then restart the server.`;

/**
 * If `response` is Better Auth's 403 "Invalid origin", return a friendlier copy
 * with the same status + `code` but an actionable message. Otherwise null — the
 * caller passes the original response through untouched.
 */
export const rewriteInvalidOrigin = async (
  request: Request,
  response: Response,
  webBaseUrl: string,
): Promise<Response | null> => {
  if (response.status !== 403) return null;
  const body = await response.clone().text();
  if (!INVALID_ORIGIN.test(body)) return null;
  const message = invalidOriginHelp(originOf(request), webBaseUrl);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ code: "INVALID_ORIGIN", message }), {
    status: 403,
    headers,
  });
};
