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
  /** Discriminant of {@link ResolvedPrincipal}: an acting member, as opposed
   *  to the org-level `"platform"` credential. Required so every construction
   *  site declares which arm it is, and the union matches on a literal tag
   *  instead of probing for a property's presence. */
  readonly kind: "member";
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
  /**
   * The member's NORMALIZED workspace role, when the host resolves one:
   * `"admin"` may configure workspace-level state (org-owned rows, the
   * integration catalog), `"member"` may only use it. Cloud maps its WorkOS
   * membership role (`admin` / `member`); self-host maps Better Auth's org
   * membership role (`owner` and `admin` → `"admin"`). ABSENT means the host
   * has no role model (local's single user, test fakes) and the middleware
   * binds the executor with workspace writes allowed — hosts that DO
   * distinguish roles must always set it.
   */
  readonly orgRole?: "admin" | "member";
}

/**
 * An ORG-level credential (cloud's org-scoped API key), resolved. Deliberately
 * NOT a `Principal`: a `Principal` names an acting member, and this credential
 * has none — mirroring the resolution layer's own split (`ApiKeyOwner` keeps
 * `accountId: string | null` for the same reason). Keeping it a separate shape
 * means no code path can accidentally bind an org credential to a subject; the
 * middleware routes it to the subject-less platform executor instead, and
 * refuses every non-read method before a handler ever runs.
 *
 * Self-host and local never produce this: their credentials always name a
 * member. It exists on the NEUTRAL seam so the shared middleware owns the
 * platform branch once, instead of each host reinventing it.
 */
export interface PlatformPrincipal {
  readonly kind: "platform";
  readonly organizationId: string;
  readonly organizationName: string;
  /** See {@link Principal.organizationSlug}. */
  readonly organizationSlug?: string;
  /** The credential's own id, for audit trails — never an acting member. */
  readonly keyId: string;
}

/** What `authenticate` resolves: an acting member, or the org-level platform
 *  credential. */
export type ResolvedPrincipal = Principal | PlatformPrincipal;

export const isPlatformPrincipal = (value: ResolvedPrincipal): value is PlatformPrincipal =>
  value.kind === "platform";

/**
 * The single `AuthContext` every executor-API handler reads. The roles-bearing
 * tag from self-host is the model; cloud now provides `roles: []` on it, which
 * is forward-compatible (cloud handlers never read roles today).
 *
 * `accountId` and `email` are `null` for an org-level platform credential —
 * there is no acting member behind it. Nullable rather than sentinel-valued so
 * any handler that needs a member has to say so (and refuse), instead of
 * silently acting as a user that does not exist. (`email: ""` on the member
 * api-key path is the pre-existing "member with no resolved email" value and
 * unrelated to this.)
 */
export class AuthContext extends Context.Service<
  AuthContext,
  {
    readonly accountId: string | null;
    readonly organizationId: string;
    readonly email: string | null;
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

/** The platform credential's `AuthContext`: org identity, no member fields. */
export const authContextFromPlatform = (principal: PlatformPrincipal): AuthContext["Service"] => ({
  accountId: null,
  organizationId: principal.organizationId,
  email: null,
  name: null,
  avatarUrl: null,
  roles: [],
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
 * A valid PLATFORM credential (org-scoped API key) attempted something only an
 * acting member can do: a write on the product plane, or any request on a host
 * that serves no platform view (local's fixed executor). Renders 403.
 *
 * Its own tag rather than a reuse of `NoOrganization`: the caller DID present a
 * valid credential of a known org — telling them "no organization" would send
 * them debugging the wrong thing. The message names the actual constraint.
 */
export class ReadOnlyCredential extends Schema.TaggedErrorClass<ReadOnlyCredential>()(
  "ReadOnlyCredential",
  renderHints,
  { httpApiStatus: 403 },
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
export type IdentityFailure = Unauthorized | NoOrganization | Unavailable | ReadOnlyCredential;

export interface IdentityProviderShape {
  readonly authenticate: (request: Request) => Effect.Effect<ResolvedPrincipal, IdentityFailure>;
}

export class IdentityProvider extends Context.Service<IdentityProvider, IdentityProviderShape>()(
  "@executor-js/api/IdentityProvider",
) {}
