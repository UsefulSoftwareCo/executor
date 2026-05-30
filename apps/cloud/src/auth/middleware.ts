// ---------------------------------------------------------------------------
// HTTP API middleware tags — pure tag definitions, no server dependencies.
// Live implementations are in ./middleware-live.ts to keep the WorkOS SDK
// out of the client bundle (this file is imported by `auth/api.ts` which
// the SPA pulls in for typed schemas).
// ---------------------------------------------------------------------------

import { Context } from "effect";
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
// SessionAuth — resolves the WorkOS session cookie, provides SessionContext
// ---------------------------------------------------------------------------

export class SessionAuth extends HttpApiMiddleware.Service<
  SessionAuth,
  { provides: SessionContext }
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
