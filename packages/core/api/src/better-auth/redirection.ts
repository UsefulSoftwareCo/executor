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

const MCP_AUTHORIZE_PATH = "/api/auth/mcp/authorize";

export const mcpAuthorizeResumeTarget = (search: string): string | null => {
  const params = new URLSearchParams(search);
  if (params.get("response_type") !== "code") return null;
  if (!params.get("client_id") || !params.get("redirect_uri")) return null;
  return `${MCP_AUTHORIZE_PATH}?${params.toString()}`;
};

const LOGIN_PATH = "/login";

export const postLoginTarget = (location: {
  readonly pathname: string;
  readonly search: string;
}): string =>
  mcpAuthorizeResumeTarget(location.search) ??
  safeReturnTo(new URLSearchParams(location.search).get("returnTo")) ??
  (location.pathname === LOGIN_PATH
    ? null
    : safeReturnTo(`${location.pathname}${location.search}`)) ??
  "/";
