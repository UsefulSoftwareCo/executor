/**
 * Auth, host-allow, and static-route helpers shared between the Bun listener
 * (serve.ts) and the Node listener used by the desktop sidecar (serve-node.ts).
 */
import { timingSafeEqual } from "node:crypto";

export const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
];

const LOOPBACK_BIND_HOSTS = new Set<string>(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const normalizeCredential = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
};

export const safeEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export const isLoopbackBindHost = (hostname: string): boolean =>
  LOOPBACK_BIND_HOSTS.has(hostname.trim().toLowerCase());

export const makeIsAllowedHost =
  (allowed: ReadonlySet<string>) =>
  (request: Request): boolean => {
    const host = request.headers.get("host");
    if (!host) return true;
    const hostname = host.replace(/:\d+$/, "");
    return allowed.has(hostname);
  };

export const hasBearerToken = (request: Request, token: string): boolean => {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return (
    (bearer !== undefined && safeEqual(bearer, token)) ||
    safeEqual(request.headers.get("x-executor-token") ?? "", token)
  );
};

export const hasBasicPassword = (request: Request, password: string): boolean => {
  const authorization = request.headers.get("authorization");
  const encoded = authorization?.match(/^Basic\s+(.+)$/i)?.[1]?.trim();
  if (!encoded) return false;

  let decoded: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Basic auth decoding accepts untrusted header bytes
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  const actualPassword = separator >= 0 ? decoded.slice(separator + 1) : decoded;
  return safeEqual(actualPassword, password);
};

export interface AuthCredentials {
  readonly token: string | null;
  readonly password: string | null;
}

export const makeIsAuthorized =
  (auth: AuthCredentials) =>
  (request: Request): boolean =>
    (auth.token !== null && hasBearerToken(request, auth.token)) ||
    (auth.password !== null && hasBasicPassword(request, auth.password));

export const hasFileExtension = (pathname: string): boolean => {
  const lastSegment = pathname.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
};

/**
 * OAuth provider callbacks land here from the user's external browser,
 * which has no way to send our Basic auth header. The `state` parameter
 * is the cryptographic gate — each in-flight session is server-issued
 * and validated by the shared `completeOAuth` before any work happens.
 * Bypassing Basic auth on these paths is safe.
 *
 * Matches:
 * - `/api/oauth/callback` — the shared OAuth API mount point.
 * - `/api/oauth/await/<sessionId>` — polled by the Electron renderer
 *   when the user runs the flow in their system browser. The sessionId
 *   is the cryptographic flow id; results are one-shot, so a leaked
 *   poll without a matching active flow returns null.
 */
export const isUnauthenticatedOAuthCallbackPath = (pathname: string): boolean =>
  /^\/api\/oauth\/(callback|await)(\/|$)/.test(pathname);
