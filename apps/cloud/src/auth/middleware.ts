// ---------------------------------------------------------------------------
// HTTP API middleware tags — pure tag definitions, no server dependencies.
// Live implementations are in ./middleware-live.ts to keep the WorkOS SDK
// out of the client bundle (this file is imported by `auth/api.ts` which
// the SPA pulls in for typed schemas).
// ---------------------------------------------------------------------------

import { Context } from "effect";
import type { HttpServerResponse } from "effect/unstable/http";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi";

// The executor-API identity seam lives in `@executor-js/api/server`: the one
// `AuthContext` handlers read (carries roles) and the one `Unauthorized` /
// `NoOrganization` error pair (httpApiStatus 401 / 403), shared with self-host.
// These are the canonical tags; consumers import them from `@executor-js/api/server`
// directly. This module reads them to declare `SessionAuth` / `OrgAuth`.
import { AuthContext, NoOrganization, Unauthorized } from "@executor-js/api/server";

// ---------------------------------------------------------------------------
// Session — what every authenticated request gets
// ---------------------------------------------------------------------------

// Cookie-write options — exactly the options `HttpServerResponse.setCookieUnsafe`
// accepts (derived so they can't drift; `import type` keeps this SPA-imported
// module free of any server runtime). The auth handlers hand over the same
// `RESPONSE_COOKIE_OPTIONS` / `DELETE_COOKIE_OPTIONS` constants the existing
// `setResponseCookie` path uses, so the emitted `Set-Cookie` bytes are identical.
export type SessionCookieOptions = NonNullable<
  Parameters<typeof HttpServerResponse.setCookieUnsafe>[3]
>;

export type Session = {
  readonly accountId: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  /** May be null if the user hasn't joined an organization yet. */
  readonly organizationId: string | null;
  readonly sealedSession: string;
  readonly refreshedSession: string | null;
};

export class SessionContext extends Context.Service<SessionContext, Session>()(
  "@executor-js/cloud/Session",
) {}

// A request-scoped cookie setter, provided ALONGSIDE `SessionContext` by
// `SessionAuth` (see its `provides` below). Typed `.handle()` handlers — the
// WorkOS session-refresh on switchOrganization / createOrganization /
// acceptInvitation — return DATA, not an `HttpServerResponse`, so they can't
// attach a `Set-Cookie` directly. They `yield* SessionCookies` and queue writes;
// `SessionAuthLive` drains the queue onto the outgoing response. It's a SEPARATE
// service, not a field on `Session`, so the session DATA stays pure — `OrgAuth`
// and the account API build a `Session` but never write cookies, so they carry
// no writer. This replaces the old `@tanstack/react-start/server` `setCookie`
// import (the one thing that pulled TanStack Start into the backend graph).
export type SessionCookieSetter = {
  /** Queue a `Set-Cookie` to apply to the response. */
  readonly set: (name: string, value: string, options: SessionCookieOptions) => void;
};

export class SessionCookies extends Context.Service<SessionCookies, SessionCookieSetter>()(
  "@executor-js/cloud/SessionCookies",
) {}

/**
 * The authenticated result shape `WorkOSClient.authenticateSealedSession` /
 * `authenticateRequest` yield. Structural so the mapper below stays a pure
 * function with no WorkOS-SDK import (this module is in the SPA bundle).
 */
export type SealedSessionResult = {
  readonly userId: string;
  readonly email: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly avatarUrl?: string | null;
  readonly organizationId?: string | null;
  readonly refreshedSession?: string | undefined;
};

/** The display name WorkOS first/last fields collapse to, or `null`. */
export const sealedSessionDisplayName = (result: SealedSessionResult): string | null =>
  `${result.firstName ?? ""} ${result.lastName ?? ""}`.trim() || null;

/**
 * The ONE sealed-session → {@link Session} mapper. `SessionAuthLive` and the
 * account-API session middleware both build a `Session` from a verified
 * sealed-session result; this folds their (previously inline, byte-identical)
 * copies into one. `sealedSessionFallback` is the cookie value to keep as the
 * `sealedSession` when WorkOS didn't hand back a refreshed one (the cookie for
 * `SessionAuthLive`, `""` for the account API which never re-sets the cookie).
 */
export const sessionFromSealed = (
  result: SealedSessionResult,
  sealedSessionFallback: string,
): Session => ({
  accountId: result.userId,
  email: result.email,
  name: sealedSessionDisplayName(result),
  avatarUrl: result.avatarUrl ?? null,
  organizationId: result.organizationId ?? null,
  sealedSession: result.refreshedSession ?? sealedSessionFallback,
  refreshedSession: result.refreshedSession ?? null,
});

// ---------------------------------------------------------------------------
// SessionAuth — resolves the WorkOS session cookie; provides SessionContext AND
// the SessionCookies setter (so a typed handler can queue a session-cookie
// refresh that SessionAuthLive applies to the response).
// ---------------------------------------------------------------------------

export class SessionAuth extends HttpApiMiddleware.Service<
  SessionAuth,
  { provides: SessionContext | SessionCookies }
>()("SessionAuth", {
  error: Unauthorized,
  security: {
    cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "wos-session" }),
  },
}) {}

// ---------------------------------------------------------------------------
// OrgAuth — like SessionAuth but rejects sessions with no organization.
// Provides the shared `AuthContext` (re-exported above).
// ---------------------------------------------------------------------------

export class OrgAuth extends HttpApiMiddleware.Service<OrgAuth, { provides: AuthContext }>()(
  "OrgAuth",
  {
    error: [Unauthorized, NoOrganization],
    security: {
      cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "wos-session" }),
    },
  },
) {}
