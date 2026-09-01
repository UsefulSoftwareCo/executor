// ---------------------------------------------------------------------------
// Admin Users HTTP API — the public, tenant-wide operator surface.
//
// The product plane (`/api/*`) answers "what can I, this member, reach". This
// one answers the OWNER's question: "who are my users, and what have they
// connected". It reads the SDK's platform view (`executor.admin`, opt-in via
// `platformView: true`), which is read-only by construction — the owner policy
// rejects writes at `reach: "tenant"` — so every endpoint here is a GET.
//
// VOCABULARY: this is the translation seam. Internal code says subject / tenant
// / reach; everything public-facing says users / owners. `AdminSubject
// .externalId` becomes `externalId` on a `users` collection, and nothing below
// leaks the word "subject".
//
// FIELD DISCIPLINE: the response shapes are 1:1 with the SDK's hand-picked
// admin allowlist (`AdminSubject` / `AdminConnection`), NOT a projection of the
// underlying rows. No credential material of any kind may appear — no item ids,
// no refresh ids, no oauth client secrets, no tokens. `oauthScope` is a summary
// of ACCESS (which scopes were granted), never a token. Adding a field here is
// a deliberate act that has to be argued against `platform-view.test.ts`'s
// forbidden-field list.
//
// The allowlist is applied per FIELD, not per column: a column may be allowed
// while the object inside it is not. `lastHealth` is the live case — the SDK's
// `HealthCheckResult` carries upstream-derived content (`identity`, `detail`,
// `responseSample`), so this contract narrows it to `AdminConnectionHealth`
// rather than forwarding the nested object. Any future nested field arrives
// under the same rule: project it, don't re-export it.
//
// Auth is applied by each host's own admin middleware (cloud: an org-scoped API
// key or an admin session member; self-host: a Better Auth owner/admin member),
// so this contract carries no provider-specific auth scheme — the same shape
// the Account API uses.
// ---------------------------------------------------------------------------

import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { ConnectionName, HealthStatus, IntegrationSlug, Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdminUsersError extends Schema.TaggedErrorClass<AdminUsersError>()(
  "AdminUsersError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export class AdminUsersUnauthorized extends Schema.TaggedErrorClass<AdminUsersUnauthorized>()(
  "AdminUsersUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class AdminUsersForbidden extends Schema.TaggedErrorClass<AdminUsersForbidden>()(
  "AdminUsersForbidden",
  {},
  { httpApiStatus: 403 },
) {}

/**
 * No user of THIS tenant matches the identifier. Distinct from 401/403 on
 * purpose: an operator polling one user needs "this person has no footprint
 * here" to be a different, non-alarming answer from "your credential is
 * wrong". Carries no echo of the identifier — an admin credential is already
 * scoped to one tenant, but reflecting input into an error body is a habit
 * worth not having.
 *
 * Deliberately does NOT distinguish "never existed" from "exists in the host
 * directory but never touched executor": see the `getUser` docs below.
 */
export class AdminUserNotFound extends Schema.TaggedErrorClass<AdminUserNotFound>()(
  "AdminUserNotFound",
  {},
  { httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Response schemas — the public projection of the SDK's admin shapes.
// ---------------------------------------------------------------------------

/**
 * One user of the tenant. Mirrors `AdminSubject` with the public vocabulary.
 *
 * `lastSeenAt` is epoch ms of the last sighting on the request path, and is
 * deliberately COARSE: the writer (`touchSubject`) only rewrites it past a
 * throttle interval (1 hour by default), so treat it as "active around then",
 * never as a precise last-activity timestamp. `null` means never seen on a
 * request — a user can earn a row at connection-create before any sighting.
 */
export const AdminUser = Schema.Struct({
  /** The host-auth principal id (cloud: the WorkOS user id). Opaque — it also
   *  carries host sentinels like "local", so nothing may parse it. */
  externalId: Schema.String,
  /** Epoch ms the user was first recorded under this tenant. */
  createdAt: Schema.Number,
  lastSeenAt: Schema.NullOr(Schema.Number),
  /** User lifecycle. Unconstrained until the lifecycle values are defined;
   *  `null` means no state recorded (which is every row today). */
  status: Schema.NullOr(Schema.String),
  /**
   * The host's email for this principal, joined server-side from the host's own
   * member directory (cloud: WorkOS; self-host: Better Auth). `null` whenever
   * the host cannot resolve the id — the member left the org while their
   * connections remain, the directory read failed, or the id is a host sentinel
   * like "local" that names no member at all.
   *
   * NOT credential material and not part of the storage projection: it is a
   * directory lookup keyed by `externalId`, which is why it can be absent on a
   * row whose other fields are complete. Nothing may treat its presence as an
   * authorization signal.
   */
  email: Schema.NullOr(Schema.String),
  /** The host's human name for this principal (cloud: given + family name;
   *  self-host: the Better Auth `name`). `null` on the same terms as `email`,
   *  and independently — a directory can hold one without the other. */
  displayName: Schema.NullOr(Schema.String),
});

/**
 * The admin plane's view of a stored health verdict — a deliberate PROJECTION
 * of the SDK's `HealthCheckResult`, not that type re-exported.
 *
 * WHY THIS IS ITS OWN SCHEMA. `HealthCheckResult` is the OWNER's view of their
 * own probe, and it carries content lifted from the upstream provider's actual
 * response: `identity` (the display value extracted from `identityField` —
 * typically the account's email AT THE PROVIDER), `detail` (a raw diagnostic
 * message, which for an HTTP failure can quote the upstream body), and
 * `responseSample` (up to 25 scalar leaves of the real response body, ~120
 * chars each, via `extractResponseFields`). That is fine on the product plane,
 * where the caller IS the credential's owner. It is not fine here: this plane
 * reports on OTHER people's connections, so forwarding the whole nested object
 * would hand an operator another user's upstream account identity and sampled
 * response content. The per-column allowlist in `admin/reads.ts` cannot catch
 * that on its own — it allowlists the COLUMN and then forwards everything
 * inside it — so the narrowing is expressed here, in the contract.
 *
 * WHAT SURVIVES. `status` answers the only question this plane asks ("is it
 * healthy"), and `checkedAt` says how stale that answer is. Both are derived
 * verdicts about the connection, never content from the provider's response.
 * `httpStatus` is deliberately dropped as well: it is a diagnostic for the
 * credential's owner, and adding fields here has to be argued against the
 * forbidden-field lists in `platform-view.test.ts` and `admin-users.test.ts`.
 */
export const AdminConnectionHealth = Schema.Struct({
  /** The stored verdict: healthy / expired / misconfigured / degraded / unknown. */
  status: HealthStatus,
  /** Epoch ms the check ran, so an operator can tell a fresh verdict from a
   *  stale one. */
  checkedAt: Schema.Number,
  /** Enumerable failure mechanism — a `HealthCheckReason` literal. Carried so
   *  the view can tell a tool-sync stamp (`tool_sync_failed` — catalog state,
   *  not credential health) from a genuine probe verdict without the free-text
   *  `detail` this plane deliberately strips. Typed as a plain string ON
   *  PURPOSE: the reason enum grows, and a closed set here would make a client
   *  built today fail the WHOLE admin response the first time one connection
   *  carries a literal it doesn't know. Clients treat unrecognized values as
   *  unclassified. */
  reason: Schema.optional(Schema.String),
});

/**
 * A connection as the platform view sees it: enough to answer "what has this
 * user connected, and is it healthy", and nothing that could resolve a
 * credential — or name the upstream account. Mirrors `AdminConnection`, except
 * that `lastHealth` is narrowed to `AdminConnectionHealth` (see above).
 */
export const AdminUserConnection = Schema.Struct({
  owner: Owner,
  integration: IntegrationSlug,
  name: ConnectionName,
  /** The scope set the provider actually granted, space-delimited as recorded
   *  at connect/refresh. Null for static credentials. A summary of ACCESS —
   *  never a token. */
  oauthScope: Schema.NullOr(Schema.String),
  /** The stored health verdict, PROJECTED to status + checkedAt. Never the
   *  SDK's full `HealthCheckResult`: see `AdminConnectionHealth`. */
  lastHealth: Schema.NullOr(AdminConnectionHealth),
});

/** A user joined with every connection they own in the tenant. */
export const AdminUserWithConnections = Schema.Struct({
  ...AdminUser.fields,
  connections: Schema.Array(AdminUserConnection),
});

export const AdminUsersResponse = Schema.Struct({
  users: Schema.Array(AdminUser),
});

export const AdminUserConnectionsResponse = Schema.Struct({
  connections: Schema.Array(AdminUserConnection),
});

export const AdminUsersWithConnectionsResponse = Schema.Struct({
  users: Schema.Array(AdminUserWithConnections),
});

/** One user, identity and connections together. Wrapped in `{ user }` rather
 *  than returned bare so the response can grow a sibling field without a
 *  breaking change — the same reason every list here is wrapped. */
export const AdminUserResponse = Schema.Struct({
  user: AdminUserWithConnections,
});

// ---------------------------------------------------------------------------
// Params / query
// ---------------------------------------------------------------------------

const AdminUserParams = { externalId: Schema.String };

/**
 * The single-user path parameter, which names a user by EITHER identifier the
 * operator has: the opaque `externalId`, or their email.
 *
 * WHY ONE PARAM AND NOT A `?email=` VARIANT. The alternative — `GET
 * /admin/users?email=` returning the matched user — would make one endpoint
 * answer with two different shapes (a list, or one user), which is exactly the
 * thing the group comment below rules out: this repo's query params FILTER a
 * fixed shape, they never switch it. Two identifiers for one resource is what
 * a path parameter is for, and it keeps "fetch the user I am asking about" as
 * one route with one response schema and one 404.
 *
 * DISAMBIGUATION is by shape — an identifier containing "@" is tried as an
 * email — but that is a ROUTING HINT, not a parse of the id. `externalId` is
 * opaque by contract, so the resolver falls back to a literal id lookup when
 * the email interpretation matches nothing. No host mints an id containing
 * "@" today (cloud: `user_...`; self-host: a Better Auth id; sentinels like
 * "local"), so the fallback is a safety net rather than a live path — but it
 * means the opacity rule is never actually violated.
 *
 * Note the value arrives URL-DECODED, so a client sends `alice%40example.com`
 * and the handler sees `alice@example.com`.
 */
const AdminUserIdentifierParams = { identifier: Schema.String };

// Paging, mirroring `AdminListSubjectsOptions`. Query params arrive as strings,
// so decode them here rather than making every handler interpret raw strings —
// a non-numeric, FRACTIONAL, or out-of-range value is a 400 from the contract,
// not a silently-ignored filter and not a value handed to the driver.
//
// `isInt` is load-bearing, not decoration: `FiniteFromString` alone accepts
// "1.5", and a fractional limit reached the driver as a `datatype mismatch`
// 500. A row count is an integer by nature, so rejecting the fraction is the
// honest answer rather than rounding a caller's request into something they
// did not ask for.
//
// OMITTING these is not the same as passing 0. The SDK applies its own default
// page size (`ADMIN_DEFAULT_PAGE_SIZE`, 100) and clamps to
// `ADMIN_MAX_PAGE_SIZE` (500, the `maximum` below), so every response is a
// bounded page — including `?offset=` with no `limit=`, which is a valid
// request that pages through the default-sized window.
//
// `email` is an exact-match FILTER on the fixed list shape (the response is
// still a `users` array, empty when nothing matches), which is how every other
// list here uses query params. It selects a specific principal rather than
// narrowing a scan, so the read resolves the address to an id and reads THAT
// id — it does not page the tenant and keep the row that matches.
//
// FILTER, THEN PAGE, in that order. The window therefore applies to the
// selected row rather than to the scan it would once have been found in: with
// a filter present a response is one row at `offset: 0` and empty beyond it.
// Paging is applied rather than ignored so the endpoint keeps one set of
// semantics, not two — but on a filter that names a single principal it can
// only ever include or exclude that principal.
//
// Carried as a plain string: the trim + lower-case normalization lives at the
// handler seam (`normalizeEmail`), which is also where the single-user path
// parameter is normalized, so both entry points share ONE rule rather than a
// schema transform on one and hand-rolled code on the other.
const AdminListQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
  ),
  offset: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  email: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

/**
 * The admin users group, mounted at `/admin/*` by each host.
 *
 * The joined view is its OWN path (`/admin/users/with-connections`) rather than
 * an `?include=connections` flag on `/admin/users`, because the two return
 * different row shapes. A query flag that changes the response schema can't be
 * expressed as one typed endpoint — the repo's list endpoints use query params
 * only to FILTER a fixed shape (`/tools`, `/connections`), never to switch it.
 * It sorts before `/admin/users/:externalId/...` in the router either way, and
 * "with-connections" is not a valid opaque principal id.
 *
 * ROUTER ORDERING, re-verified now that `/admin/users/:identifier` exists and
 * collides with `/admin/users/with-connections` at the same path depth. The
 * router is find-my-way (`HttpRouter` builds on effect's vendored copy), a
 * radix tree that ranks a STATIC segment above a parametric one at the same
 * position regardless of registration order. Probed directly against the
 * pinned build with the parametric route registered FIRST — the worst case —
 * and `/admin/users/with-connections` still resolves to the list endpoint,
 * while `/admin/users/user_123` and `/admin/users/alice%40example.test` both
 * resolve to the single-user endpoint. The original comment's claim therefore
 * still holds, and the endpoint order below is documentation rather than the
 * thing that makes it work. Registering `:identifier` here and `:externalId`
 * on the nested route is likewise fine: the names differ but they sit at the
 * same position, and the tree matches on position, not on name.
 */
export const AdminUsersApi = HttpApiGroup.make("adminUsers")
  .add(
    HttpApiEndpoint.get("listUsers", "/admin/users", {
      query: AdminListQuery,
      success: AdminUsersResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("listUsersWithConnections", "/admin/users/with-connections", {
      query: AdminListQuery,
      success: AdminUsersWithConnectionsResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("listUserConnections", "/admin/users/:externalId/connections", {
      params: AdminUserParams,
      success: AdminUserConnectionsResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden],
    }),
  )
  /**
   * One user by `externalId` OR email, identity and connections in a single
   * call — the read a per-user check makes, which operators run far more often
   * than the bulk list.
   *
   * NOT-FOUND SEMANTICS. `AdminUserNotFound` (404) means "no subject row under
   * this tenant matches", and that is the answer even when the host directory
   * DOES know the email. A member who was invited but never touched executor
   * has no footprint on this plane, and the admin plane exists to report
   * footprint: "who are my users and what have they connected". Returning
   * directory identity with an empty `connections` array would answer a
   * question this API was not asked — it would make "is a member of the org"
   * and "is a user of executor" the same answer, and a caller gating on that
   * would treat a never-onboarded invitee as onboarded. 404 keeps the two
   * distinct, and the org's membership roster is already the account plane's
   * job (`/account/members`). The bulk `?email=` filter agrees: it returns an
   * empty list, never a synthesized row.
   */
  .add(
    HttpApiEndpoint.get("getUser", "/admin/users/:identifier", {
      params: AdminUserIdentifierParams,
      success: AdminUserResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden, AdminUserNotFound],
    }),
  );

/**
 * Standalone HttpApi wrapping just the admin users group. Hosts mount THIS as
 * an extension route (like the account API) rather than adding the group to
 * `CoreExecutorApi`: the core API is served behind the execution-stack
 * middleware, which binds a product-view executor to one acting subject. The
 * admin plane needs the opposite (no subject, tenant reach), so it gets its own
 * mount and its own per-host auth.
 */
export const AdminUsersHttpApi = HttpApi.make("executor-admin-users").add(AdminUsersApi);
