// ---------------------------------------------------------------------------
// Provider-neutral identity seam — the ONE auth surface the executor API runs
// on. Cloud (WorkOS api-key + sealed-session) and self-host (Better Auth) each
// supply an `IdentityProvider` Layer; the shared `ExecutionStackMiddleware`
// (see `./execution-stack-middleware.ts`) consumes only this tag, never a
// provider's native session shape. Handlers depend only on `AuthContext`.
//
// Single source of truth promoted out of the two apps:
//   - `Principal`        — the neutral resolved identity (self-host's shape is
//                          the model: org name + roles; cloud passes `roles: []`
//                          and an empty email on the api-key path).
//   - `AuthContext`      — the one Context.Service handlers read (carries roles;
//                          cloud's old tag lacked them, forward-compatible).
//   - `Unauthorized` /   — the shared error set (httpApiStatus 401 / 403 / 503),
//     `NoOrganization` /   shared by every consumer in both apps. Self-host only
//     `Unavailable`        ever produces the first two; cloud also produces
//                          `Unavailable` (503) when api-key validation is down.
//   - `IdentityProvider` — the swap seam: `authenticate(request) =>
//                          Effect<Principal, Unauthorized | NoOrganization |
//                          Unavailable>`.
// ---------------------------------------------------------------------------

import { Context, Effect, Schema } from "effect";

/**
 * The provider-neutral resolved identity. Both self-host's AuthProvider impls
 * (single-admin, Better Auth) and cloud's WorkOS path produce this. Self-host's
 * original `Principal` is the model — it carries `organizationName` (cloud's
 * resolver already yielded it) AND `roles` (cloud supplies `[]`).
 */
export interface Principal {
  readonly accountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  /**
   * The org's URL slug (`acme`), when the resolver has it. Optional because not
   * every principal source carries it (api-key paths that never load the org
   * row). Threaded into browser-handoff URLs so they open the right org's
   * console; a missing slug just falls back to a bare, client-canonicalized URL.
   */
  readonly organizationSlug?: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly roles: readonly string[];
}

/**
 * The single `AuthContext` every executor-API handler reads. The roles-bearing
 * tag from self-host is the model; cloud now provides `roles: []` on it, which
 * is forward-compatible (cloud handlers never read roles today).
 */
export class AuthContext extends Context.Service<
  AuthContext,
  {
    readonly accountId: string;
    readonly organizationId: string;
    readonly email: string;
    readonly name: string | null;
    readonly avatarUrl: string | null;
    readonly roles: readonly string[];
  }
>()("@executor-js/api/AuthContext") {}

/** Build the shared `AuthContext` value from a resolved `Principal`. */
export const authContextFromPrincipal = (principal: Principal): AuthContext["Service"] => ({
  accountId: principal.accountId,
  organizationId: principal.organizationId,
  email: principal.email,
  name: principal.name,
  avatarUrl: principal.avatarUrl,
  roles: principal.roles,
});

// Optional per-failure render hints. Self-host produces the bare error (these
// stay `undefined`) and its text strategy renders a generic body. Cloud fills
// `code` + `message` so its failure strategy can reproduce the exact
// `{ error, code }` JSON bytes its old `HttpResponseError` paths emitted. The
// status is fixed by the tag (401 / 403 / 503), so it is not carried as a field.
const renderHints = {
  /** Machine-readable failure code (cloud's `{ code }` body field). */
  code: Schema.optional(Schema.String),
  /** Human-readable message (cloud's `{ error }` body field). */
  message: Schema.optional(Schema.String),
} as const;

/** Authenticated but not authorized — no valid credential. Renders 401. */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  renderHints,
  { httpApiStatus: 401 },
) {}

/** Valid credential, but the principal belongs to no organization. Renders 403. */
export class NoOrganization extends Schema.TaggedErrorClass<NoOrganization>()(
  "NoOrganization",
  renderHints,
  { httpApiStatus: 403 },
) {}

/**
 * The credential could not be validated for a transient reason (cloud's api-key
 * validation backend is down). Renders 503 — the caller should retry. Self-host
 * never produces this; it is part of the shared set so cloud provides the SAME
 * neutral `IdentityProvider` tag without a wider error channel.
 */
export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()(
  "Unavailable",
  renderHints,
  { httpApiStatus: 503 },
) {}

/**
 * The swap seam. Resolves an incoming request to a `Principal`. WorkOS (cloud)
 * and Better Auth (self-host) are interchangeable implementations; nothing
 * downstream knows which is wired.
 *
 *   - succeeds with a `Principal`   -> authenticated
 *   - fails `Unauthorized`          -> no/invalid credential (renders 401)
 *   - fails `NoOrganization`        -> valid credential, no org (renders 403)
 *   - fails `Unavailable`           -> transient validation outage (renders 503;
 *                                      cloud only — self-host never produces it)
 *
 * Adapter-specific credential precedence (cloud's Bearer-api-key-beats-sealed-
 * session, self-host's cookie/bearer/x-api-key cascade) stays INSIDE each impl.
 * Adapter infra defects (cloud's WorkOS / user-store failures) are `Effect.die`d
 * INSIDE the impl so they surface as 500 defects, never as this error channel.
 */
export type IdentityFailure = Unauthorized | NoOrganization | Unavailable;

export interface IdentityProviderShape {
  readonly authenticate: (request: Request) => Effect.Effect<Principal, IdentityFailure>;
}

export class IdentityProvider extends Context.Service<IdentityProvider, IdentityProviderShape>()(
  "@executor-js/api/IdentityProvider",
) {}
