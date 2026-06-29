// ---------------------------------------------------------------------------
// returnTo — the "send me back where I was" path carried through the login
// flow (SSR gate → /login → /api/auth/login → OAuth state param → callback).
//
// The value crosses trust boundaries (query params, the state round-tripped
// through the identity provider), so every consumer validates with
// `isSafeReturnTo` before using it: same-origin relative paths only — no
// absolute/protocol-relative URLs (open redirect) and nothing under /api
// (bouncing a fresh login into an API endpoint is never what the user meant).
//
// Pure string code — imported by server handlers and the login page alike.
// ---------------------------------------------------------------------------

const pathPart = (path: string): string => path.split(/[?#]/, 1)[0] ?? "";

const isOAuthCallbackReturnTo = (path: string): boolean => pathPart(path) === "/api/oauth/callback";

export const isSafeReturnTo = (path: string): boolean =>
  path.startsWith("/") &&
  !path.startsWith("//") &&
  (!/^\/api(\/|$)/.test(path) || isOAuthCallbackReturnTo(path));

/** The validated returnTo, or null when absent/unsafe. */
export const safeReturnTo = (path: string | null | undefined): string | null =>
  path && isSafeReturnTo(path) ? path : null;

/** The /login URL that comes back to `returnTo` ("/" needs no parameter). */
export const loginPath = (returnTo: string): string =>
  returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;
