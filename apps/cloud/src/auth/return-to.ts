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

const RETURN_TO_ORIGIN = "https://executor.invalid";

/** Parse a same-origin landing path, or return null for absent or unsafe input. */
export const safeReturnTo = (path: string | null | undefined): string | null => {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;
  // Browsers treat backslashes as path separators and strip some control
  // characters. Reject those spellings before interpreting the destination.
  for (const character of path) {
    if (character === "\\" || character <= " " || character === "\u007f") return null;
  }

  // The fixed origin and single leading slash guarantee a parseable URL.
  // Check the normalized pathname so dot segments cannot bypass the API gate.
  const destination = new URL(path, RETURN_TO_ORIGIN);
  if (destination.origin !== RETURN_TO_ORIGIN) return null;
  if (/^\/api(\/|$)/.test(destination.pathname) && destination.pathname !== "/api/oauth/callback") {
    return null;
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
};

/** Whether a value parses as a same-origin landing path. */
export const isSafeReturnTo = (path: string): boolean => safeReturnTo(path) !== null;

/** The /login URL that comes back to `returnTo` ("/" needs no parameter). */
export const loginPath = (returnTo: string): string =>
  returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;
