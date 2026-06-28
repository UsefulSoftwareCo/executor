/**
 * Auth, CORS, and static-route helpers for the local Bun listener (serve.ts).
 *
 * Local has ONE credential: the locally-minted bearer token (see auth.ts), and
 * that is the entire security boundary. There is deliberately no Host allowlist
 * (DNS-rebinding defense): a cross-origin page can't read the token — it lives
 * in the real origin's storage and is sent as an explicit header, never an
 * ambient cookie — so it can't forge an authenticated request no matter which
 * host it connects through. Dropping the Host gate is what lets a local
 * instance be reached over a tailnet (or any hostname) with no extra flag.
 * These helpers express the bearer gate, the CORS origin allowlist, and the
 * single unauthenticated OAuth-callback carve-out.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Loopback hostnames granted credentialed CORS access by default (any port).
 * This is the only place hostnames are matched — for CORS, not for a Host gate.
 */
export const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
];

export const normalizeCredential = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
};

export const safeEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const hostnameFromOrigin = (origin: string): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: parsing an untrusted Origin header that may be malformed
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
};

/**
 * Whether a cross-origin request's `Origin` is allowed CORS access. Only the
 * loopback host allowlist (any port) plus operator-added hosts qualify — never
 * a reflected arbitrary origin. This is what keeps `Allow-Credentials: true`
 * from handing an authenticated cross-origin channel to any web page.
 */
export const isAllowedOrigin = (origin: string, allowed: ReadonlySet<string>): boolean => {
  const hostname = hostnameFromOrigin(origin);
  if (hostname === null) return false;
  return allowed.has(hostname) || allowed.has(`[${hostname}]`);
};

export const hasBearerToken = (request: Request, token: string): boolean => {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer !== undefined && safeEqual(bearer, token);
};

/** The request gate: a valid `Authorization: Bearer <token>` header. */
export const makeIsAuthorized =
  (token: string) =>
  (request: Request): boolean =>
    hasBearerToken(request, token);

export const hasFileExtension = (pathname: string): boolean => {
  const lastSegment = pathname.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
};

/**
 * OAuth provider callbacks land here from the user's external browser, which
 * has no way to send our bearer header. The `state` parameter is the
 * cryptographic gate — each in-flight session is server-issued and validated by
 * the shared `completeOAuth` before any work happens. Bypassing the bearer on
 * this ONE path is safe.
 *
 * Note: the result-polling path (`/api/oauth/await/<sessionId>`) is NOT exempt —
 * it is polled by our own renderer, which carries the bearer (the desktop
 * webview injects it; the web SPA sends it from its stored token).
 */
export const isUnauthenticatedOAuthCallbackPath = (pathname: string): boolean =>
  /^\/api\/oauth\/callback(\/|$)/.test(pathname);

export const isUnauthenticatedOAuthClientMetadataPath = (pathname: string): boolean =>
  pathname === "/api/oauth/client-id-metadata.json" ||
  /^\/api\/oauth\/client-id-metadata\/[^/]+\.json$/.test(pathname);

export const isUnauthenticatedOAuthPath = (pathname: string): boolean =>
  isUnauthenticatedOAuthCallbackPath(pathname) ||
  isUnauthenticatedOAuthClientMetadataPath(pathname);
