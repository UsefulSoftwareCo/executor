// Force a human approval screen on every MCP OAuth connection.
//
// Better Auth's MCP authorize endpoint only shows the consent page when the
// request carries `prompt=consent` (it otherwise auto-issues an authorization
// code — see better-auth/plugins/mcp/authorize). MCP clients don't send that,
// so a connecting client would be granted a token with no human approval. This
// wraps Better Auth's web handler and adds `consent` to the `prompt` of every
// `GET /api/auth/mcp/authorize`, so — paired with `oidcConfig.consentPage` —
// every connect is gated on the `/oauth/consent` approval screen.
//
// Pure + Effect-free; the wrapper is a plain Request -> Request transform so it
// composes with whatever serves the Better Auth handler (prod + vite dev both
// mount the same handler).

const AUTHORIZE_PATH = "/api/auth/mcp/authorize";
const CONSENT_PAGE = "/mcp-consent";

/** Merge `consent` into a possibly-empty space-separated `prompt` value. */
export const promptWithConsent = (prompt: string | null): string => {
  const set = new Set((prompt ?? "").split(/\s+/).filter((value) => value.length > 0));
  set.add("consent");
  return Array.from(set).join(" ");
};

/**
 * Return the MCP-authorize request with `prompt=consent` ensured, or the
 * original request unchanged when it isn't an MCP authorize call.
 */
export const withForcedMcpConsent = (request: Request): Request => {
  if (request.method !== "GET") return request;
  const url = new URL(request.url);
  if (url.pathname !== AUTHORIZE_PATH) return request;
  const prompt = url.searchParams.get("prompt");
  if (prompt && prompt.split(/\s+/).includes("consent")) return request;
  url.searchParams.set("prompt", promptWithConsent(prompt));
  return new Request(url, request);
};

/**
 * If `location` is Better Auth's redirect to the consent page carrying a
 * `client_id` but no `client_name`, return that client id (so the caller can
 * look up the registered name and enrich the redirect). Otherwise null.
 * Better Auth's authorize only puts the opaque `client_id` on the consent
 * redirect; the registered name makes the approval screen legible.
 */
export const consentRedirectClientId = (location: string | null): string | null => {
  if (!location) return null;
  const url = new URL(location, "http://host.internal");
  if (url.pathname !== CONSENT_PAGE) return null;
  if (url.searchParams.get("client_name")) return null;
  return url.searchParams.get("client_id");
};

/** Append `client_name` to a consent-page redirect URL (path + query only). */
export const withClientName = (location: string, clientName: string): string => {
  const url = new URL(location, "http://host.internal");
  url.searchParams.set("client_name", clientName);
  return `${url.pathname}${url.search}`;
};
