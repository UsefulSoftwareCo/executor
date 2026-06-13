// The origin the BROWSER sees for a document request — what origin-derived UI
// (the connect card's MCP URL, the API client's base) must be built from.
//
// On Cloudflare `request.url` already carries the external `https://` origin,
// so this is a no-op there. Behind a TLS-terminating reverse proxy that
// forwards plain HTTP upstream — `tailscale serve` for the dev-share workflow,
// or an nginx/Caddy front — `request.url` is `http://` while the browser is on
// `https://`; honoring the proxy's `X-Forwarded-Proto`/`-Host` recovers the
// real origin (otherwise the HTTPS page would seed an `http://` API base and
// the browser blocks it as mixed content).
//
// Trusting these headers is safe: the result only shapes the origin rendered
// back to that same requester, never a cross-tenant decision (org access is
// enforced server-side regardless of the URL the client was handed).
//
// Pure (no `cloudflare:workers`) so it unit-tests without the worker runtime.
export const browserOriginFromRequest = (request: Request): string => {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (!proto && !host) return url.origin;
  return `${proto || url.protocol.replace(":", "")}://${host || url.host}`;
};
