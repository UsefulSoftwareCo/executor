import { decodeOAuthCallbackState } from "@executor-js/sdk/shared";

/** Give an admin a verification path without consuming the pending OAuth callback. */
export const oauthAdminVerificationResponse = async (
  request: Request,
  response: Response,
): Promise<Response> => {
  if (
    response.status !== 403 ||
    request.method !== "GET" ||
    response.headers.get("x-executor-error") !== "org_write_denied"
  )
    return response;
  const url = new URL(request.url);
  const state = decodeOAuthCallbackState(url.searchParams.get("state"));
  if (!state) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  // The callback stays in this tab. No provider code or state enters another URL,
  // frontend telemetry, browser storage, or the verification tab's referrer.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock administration · Executor</title><style>body{font:16px system-ui;margin:10vh auto;padding:24px;max-width:480px;color:#e5e7eb;background:#111827}h1{font-size:24px}p{line-height:1.6}a{color:#a5b4fc;display:inline-block;margin:12px 20px 12px 0}</style></head><body><h1>Unlock administration</h1><p>Unlock administration in a new tab. Then return here to finish the Workspace connection. Personal connections do not need this step.</p><a href="/${encodeURIComponent(state.orgSlug)}/org" target="_blank" rel="noopener noreferrer">Unlock administration</a><a href="">Continue connection</a></body></html>`,
    { status: 200, headers },
  );
};
