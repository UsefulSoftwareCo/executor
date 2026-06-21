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
