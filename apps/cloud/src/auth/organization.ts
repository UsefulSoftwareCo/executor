// ---------------------------------------------------------------------------
// Organization resolution + authorization.
//
// One module for the cloud org auth-resolution path:
//   - `resolveOrganization`  — local mirror with lazy WorkOS fallback.
//   - `authorizeOrganization` — membership check against the local membership
//     mirror, returns the resolved org.
//
// Deliberately billing-FREE: this module is reached by the MCP session DO bundle
// (via `mcp/auth.ts`), which must not transitively import any billing config
// (`autumn.config` / `atmn`). The free-organizations-per-user limit predicates —
// which DO depend on the Autumn plan config — live in `extensions/billing/plans.ts`.
// ---------------------------------------------------------------------------

import { Clock, Effect } from "effect";
import { MemberDirectory } from "@executor-js/api/server";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import { UserStoreService } from "./context";
import { ensureOrganizationBackfilled } from "./mirror-feeders";
import { MirrorReadiness, MirrorReadinessState, describeMirrorReadiness } from "./mirror-readiness";
import type { Organization } from "./user-store";
import { WorkOSClient } from "./workos";

// ---------------------------------------------------------------------------
// Resolution — local mirror with lazy WorkOS fallback.
// ---------------------------------------------------------------------------
//
// We keep a minimal local mirror of organizations so domain tables can
// foreign-key against them and so we don't hit WorkOS on every request.
// But the mirror can drift: a user's session can reference an org that was
// created outside this app (or before the mirror existed). Rather than
// proactively mirroring on every login — which was the source of the messy
// callback flow we just untangled — we mirror lazily the first time an
// unknown org is read. All other callers just do `getOrganization` and get
// a self-healing lookup for free.
//
// URL slugs are OURS (WorkOS orgs have none) and are minted at the moment a
// row is inserted — `upsertOrganization` is the single mint point, so the
// mirror-on-first-read below produces a slugged, routable org without any
// read-path healing.

export const resolveOrganization = (organizationId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const existing = yield* users.use("getOrganization", (s) => s.getOrganization(organizationId));
    if (existing) return existing;

    const workos = yield* WorkOSClient;
    const fresh = yield* workos.getOrganization(organizationId);
    return yield* users.use("upsertOrganization", (s) =>
      s.upsertOrganization({
        id: fresh.id,
        name: fresh.name,
        updatedAt: new Date(fresh.updatedAt),
      }),
    );
  });

// ---------------------------------------------------------------------------
// Deletion mark — the local step that revokes an organization.
// ---------------------------------------------------------------------------
//
// Membership is authorized from the local mirror (below), so deleting the
// WorkOS organization revokes nothing here by itself: the local membership
// rows keep authorizing sessions until the local purge removes them, and a
// purge that fails leaves them live. This mark is what revokes access, and it
// is the FIRST step of cloud's deletion flow (`auth/handlers.ts`
// deleteOrganization) — before the WorkOS delete and the purge, both of which
// can fail — and what the `organization.deleted` event applies
// (`workos-events-sync.ts`) when the org was deleted in the WorkOS dashboard
// instead. Membership rows are left as they are; the mark alone refuses them.
// Idempotent: a retry keeps the first mark. An org the mirror does not hold
// is not marked (nothing to revoke), and `false` says so.

export const markOrganizationDeleted = (organizationId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const at = new Date(yield* Clock.currentTimeMillis);
    const marked = yield* users.use("markOrganizationDeleted", (s) =>
      s.markOrganizationDeleted(organizationId, at),
    );
    return marked !== null;
  });

// ---------------------------------------------------------------------------
// Authorization — membership check against the local membership mirror.
// ---------------------------------------------------------------------------
//
// The sealed session cookie carries an organizationId that WorkOS signed at
// login / refresh time. WorkOS does NOT invalidate existing sessions when a
// membership is revoked, and `session.authenticate()` validates the JWT
// locally without hitting the API — so a removed user would keep full access
// until their access token naturally expired (~10 min) if the session were
// trusted on its own.
//
// To close that gap, membership is verified on every protected request — but
// against the LOCAL mirror of WorkOS memberships (`memberships` join
// `accounts`, read through the shared `MemberDirectory`), never against WorkOS
// itself. This used to be one `listUserMemberships` call per request (2026-07:
// deliberately NOT cached, because a positive TTL cache is exactly what would
// re-open the revocation gap). The mirror is not a cache with a TTL; it is a
// replica whose freshness is defined by its feeders:
//   - login (`auth/handlers.ts` callback): the user and every membership WorkOS
//     lists for them, from the list the callback already fetches;
//   - write-through: every membership change Executor makes (create org,
//     invite, accept, remove, change role) lands in the mirror in the same
//     request, so a revocation through Executor is denied on the NEXT request;
//   - the WorkOS Events API reconciler (`workos-events-sync.ts`, every minute
//     by cron plus a signed webhook poke): changes made in the WorkOS
//     dashboard land within seconds.
// The membership row must be `active`: a pending invitee is not a member, and a
// deactivated member keeps their row but not their access. And the
// organization must not be marked deleted (`organizations.deleted_at`): cloud's
// deletion flow (`auth/handlers.ts` deleteOrganization) sets that mark FIRST,
// before the WorkOS delete and the local purge, so an org whose deletion did
// not finish refuses every session at once — its membership rows are still
// there, live, until the purge removes them, and must not authorize anyone.
//
// The mirror is trusted only while it is READY (`mirror-readiness.ts`): the
// one-off backfill has written every organization, and the events reconciler
// has drained the stream within its lag budget. Until both hold, membership is
// read from WorkOS (`listUserMemberships`, one call per request) exactly as
// before the cutover — a member the backfill has not written yet must not be
// locked out, and a member revoked in the dashboard while the reconciler was
// down must not be let in on a stale row. The readiness row is one indexed
// point read on the same socket; the deploy gate
// (`scripts/ensure-workos-mirror-ready.ts`) applies the same rule before this
// build goes live, so in steady state the fallback is never taken. A
// readiness or mirror read failure fails the request (500), never a silent
// fallback in either direction. The one org the fallback never asks WorkOS
// about is one the mirror holds as DELETED: WorkOS no longer has it (or is
// about to not), so its answer is "no member" for everyone — including the
// admin whose deletion failed part-way and must retry it (below). That
// membership is read from the mirror, whose rows are exactly what the purge
// has not removed yet, ready or not; a refused caller gets null either way.
//
// Readiness is database-wide; completeness is PER ORGANIZATION. An
// organization whose row was minted after the backfill ran — lazily by a
// request (`resolveOrganization`), or by a first login — carries no
// `backfilled_at`, and the mirror holds only the memberships login and
// write-through happened to record for it: a member who has not signed in
// since would be refused on a row that was never written. So the org row is
// read FIRST, and an unmarked live organization is scanned from WorkOS
// (`ensureOrganizationBackfilled`: one membership listing plus one `getUser`
// per member, then the mark) BEFORE its mirror is read — the same on-demand
// scan the seat gates run. One-time per organization: the scan marks the
// row, and this branch is never taken for it again. An organization the
// mirror does not hold at all — one that predates the mirror and that nobody
// has signed in to since (a CLI or MCP token names it, and the JWT path has
// no login feeder), or one created in the WorkOS dashboard — is reachable by
// neither the backfill (which lists the mirror's organizations) nor the
// reconciler (which starts at the replay boundary), so it is resolved on
// demand HERE: WorkOS is asked for the caller's own membership in it first
// (`getUserOrgMembership`, a read scoped to this caller — never a listing
// of the org), and only a member's answer mints the row
// (`resolveOrganization`) and scans it as above. A non-member mints nothing:
// a signed-in caller cannot create the row of an arbitrary WorkOS
// organization by naming its id. An organization marked deleted is never
// scanned: WorkOS no longer has it, and its rows are the purge's to remove,
// not a listing's to refresh.
//
// Returns the resolved organization if the user currently holds an *active*
// membership in it, otherwise null. Callers should treat null as "no access"
// and route accordingly (onboarding page / 403).
//
// The ONE caller that may see a marked org is the deletion flow itself
// (`deleted: "allow"`): an admin whose deletion failed after the mark must be
// able to send it again to finish the purge, and their membership row is
// still there to authorize exactly that.

export interface AuthorizeOrganizationOptions {
  /** Whether an organization marked deleted resolves (`"allow"`) or is refused (default). */
  readonly deleted?: "refuse" | "allow";
}

/** The caller's active membership in the org, however it was read: only the role matters past this point. */
interface ActiveMembership {
  readonly role: string;
}

// The mirror read: the caller's row, active or nothing.
const activeMembershipFromMirror = (userId: string, organizationId: string) =>
  Effect.gen(function* () {
    const directory = yield* MemberDirectory;
    const membership = yield* directory.membership(userId, organizationId);
    if (!membership || membership.status !== "active") return null;
    const active: ActiveMembership = { role: membership.role };
    return active;
  });

// The pre-cutover read, kept for the window in which the mirror is not yet
// ready: WorkOS's own membership list for the user, one call per request.
const activeMembershipFromWorkOs = (userId: string, organizationId: string) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const memberships = yield* workos.listUserMemberships(userId);
    const membership = memberships.data.find(
      (m) => m.organizationId === organizationId && m.status === "active",
    );
    if (!membership) return null;
    const active: ActiveMembership = { role: membership.role.slug };
    return active;
  });

// The authorized organization, or null for one marked deleted (unless the
// caller is the deletion flow). The membership already names the caller's
// role — surfaced normalized so identity resolution can bind the executor's
// workspace write permission without a second read. WorkOS issues `admin` /
// `member`; anything unrecognized stays a plain member.
const authorized = (
  org: Organization,
  membership: ActiveMembership,
  options: AuthorizeOrganizationOptions,
) => {
  if (org.deletedAt !== null && options.deleted !== "allow") return null;
  const memberRole: "admin" | "member" = membership.role === "admin" ? "admin" : "member";
  return { ...org, memberRole };
};

// The organization row for a caller, minted from WorkOS when the mirror
// does not hold it — only for a caller WorkOS confirms as its member (see
// above). `null` when the mirror has no row and WorkOS lists no membership.
const heldOrResolvedForMember = (userId: string, organizationId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const held = yield* users.use("getOrganization", (s) => s.getOrganization(organizationId));
    if (held) return held;
    const workos = yield* WorkOSClient;
    const membership = yield* workos.getUserOrgMembership(organizationId, userId);
    if (!membership) return null;
    yield* Effect.logInfo(
      "authorizeOrganization: organization not mirrored; resolving it from WorkOS for its member",
      { organizationId },
    );
    return yield* resolveOrganization(organizationId);
  });

export const authorizeOrganization = (
  userId: string,
  organizationId: string,
  options: AuthorizeOrganizationOptions = {},
) =>
  Effect.gen(function* () {
    const readiness = yield* MirrorReadiness;
    const state = yield* readiness.state();
    if (!MirrorReadinessState.$is("Ready")(state)) {
      yield* Effect.logWarning(
        "authorizeOrganization: membership mirror not ready; membership read from WorkOS",
        { readiness: describeMirrorReadiness(state) },
      );
      // A marked organization is the mirror's to answer for (see above):
      // WorkOS lists no member of it, and the deletion retry must still
      // get in.
      const users = yield* UserStoreService;
      const held = yield* users.use("getOrganization", (s) => s.getOrganization(organizationId));
      if (held?.deletedAt != null) {
        if (options.deleted !== "allow") return null;
        const membership = yield* activeMembershipFromMirror(userId, organizationId);
        if (!membership) return null;
        return authorized(held, membership, options);
      }
      const membership = yield* activeMembershipFromWorkOs(userId, organizationId);
      if (!membership) return null;
      const org = yield* resolveOrganization(organizationId);
      return authorized(org, membership, options);
    }

    const org = yield* heldOrResolvedForMember(userId, organizationId);
    if (!org) return null;
    // An unmarked live organization is scanned before its mirror is read
    // (see above). The row returned below still shows the mark as it was
    // read; nothing past this point reads it.
    if (org.deletedAt === null && org.backfilledAt === null) {
      yield* ensureOrganizationBackfilled(organizationId);
    }
    const membership = yield* activeMembershipFromMirror(userId, organizationId);
    if (!membership) return null;
    return authorized(org, membership, options);
  });

// ---------------------------------------------------------------------------
// Org SELECTOR — the URL is the scope authority, not the session.
// ---------------------------------------------------------------------------
//
// Org-scoped requests carry the active org in this header, set by the web
// client from the console URL's slug (the MCP plane carries the same idea in
// its own `x-executor-mcp-organization`). The selector is a slug (`acme`, the
// readable URL form) or a WorkOS id (`org_…`, the legacy/token form). It is a
// SELECTOR, not a trust boundary: `authorizeOrganizationSelector` re-checks
// membership against the mirror, so the worst a forged header does is name an
// org the caller already belongs to.
//
// Why a header and not the session's `org_id`: a browser shares ONE cookie jar
// across tabs, so a single session-pinned org makes "active org" a
// browser-global — two tabs can't be in two orgs at once, and switching in one
// silently re-scopes the other. Scoping per-request from the URL makes each
// tab independent.

export const ORG_SELECTOR_HEADER = EXECUTOR_ORG_SELECTOR_HEADER;

/** The URL-pinned org selector for a request, or `null` to fall back to the session. */
export const orgSelectorFromRequest = (request: Request): string | null =>
  request.headers.get(ORG_SELECTOR_HEADER);

/**
 * Resolve an org SELECTOR (URL slug or `org_…` id) to the organization the
 * caller actively belongs to, or `null`. A slug resolves through the local
 * mirror to its id first; ids pass straight through. Either way membership is
 * verified against the mirror via {@link authorizeOrganization}.
 */
export const authorizeOrganizationSelector = (
  userId: string,
  selector: string,
  options: AuthorizeOrganizationOptions = {},
) =>
  Effect.gen(function* () {
    if (selector.startsWith("org_")) {
      return yield* authorizeOrganization(userId, selector, options);
    }
    const users = yield* UserStoreService;
    const org = yield* users.use("getOrganizationBySlug", (s) => s.getOrganizationBySlug(selector));
    if (!org) return null;
    return yield* authorizeOrganization(userId, org.id, options);
  });
