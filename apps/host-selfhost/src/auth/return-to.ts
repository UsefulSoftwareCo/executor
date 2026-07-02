const pathPart = (path: string): string => path.split(/[?#]/, 1)[0] ?? "";

const isOAuthCallbackReturnTo = (path: string): boolean => pathPart(path) === "/api/oauth/callback";

export const isSafeReturnTo = (path: string): boolean =>
  path.startsWith("/") &&
  !path.startsWith("//") &&
  (!/^\/api(\/|$)/.test(path) || isOAuthCallbackReturnTo(path));

export const safeReturnTo = (path: string | null | undefined): string | null =>
  path && isSafeReturnTo(path) ? path : null;

export const loginPath = (returnTo: string): string =>
  returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;

// Better Auth's MCP authorize endpoint redirects an unauthenticated client to
// `loginPage` (/login) carrying the original OAuth request as query params
// (`response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, ...).
// Unlike the integration OAuth callback (which arrives as `returnTo`), there is
// no returnTo here: the params ARE the request. After sign-in the login page
// must hand control back to the authorize endpoint so the now-authenticated
// request issues a code (and, via the consent shim, lands on /mcp-consent).
// Given a location search string, return that resume URL when it carries an MCP
// authorize request, else null. The target is our own same-origin authorize
// endpoint, which validates client_id/redirect_uri, so this is not an open
// redirect.
const MCP_AUTHORIZE_PATH = "/api/auth/mcp/authorize";

export const mcpAuthorizeResumeTarget = (search: string): string | null => {
  const params = new URLSearchParams(search);
  if (params.get("response_type") !== "code") return null;
  if (!params.get("client_id") || !params.get("redirect_uri")) return null;
  return `${MCP_AUTHORIZE_PATH}?${params.toString()}`;
};
