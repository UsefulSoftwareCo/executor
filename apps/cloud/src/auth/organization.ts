// ---------------------------------------------------------------------------
// Organization resolution + authorization.
//
// One module for the cloud org auth-resolution path:
//   - `resolveOrganization`  — local mirror with lazy WorkOS fallback.
//   - `authorizeOrganization` — live membership check, returns the resolved org.
//
// Deliberately billing-FREE: this module is reached by the MCP session DO bundle
// (via `mcp/auth.ts`), which must not transitively import any billing config
// (`autumn.config` / `atmn`). The free-organizations-per-user limit predicates —
// which DO depend on the Autumn plan config — live in `extensions/billing/plans.ts`.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import { UserStoreService } from "./context";
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
    const existing = yield* users.use((s) => s.getOrganization(organizationId));
    if (existing) return existing;

    const workos = yield* WorkOSClient;
    const fresh = yield* workos.getOrganization(organizationId);
    return yield* users.use((s) => s.upsertOrganization({ id: fresh.id, name: fresh.name }));
  });

// ---------------------------------------------------------------------------
// Authorization — live membership check against WorkOS.
// ---------------------------------------------------------------------------
//
// The sealed session cookie carries an organizationId that WorkOS signed at
// login / refresh time. WorkOS does NOT invalidate existing sessions when a
// membership is revoked, and `session.authenticate()` validates the JWT
// locally without hitting the API — so a removed user keeps full access
// until their access token naturally expires (~10 min).
//
// To close that gap we verify membership live on every protected request.
// `listUserMemberships` is one WorkOS call per request. If this becomes a
// hot path we can layer a short per-(user, org) TTL cache underneath, or
// swap it for a local memberships table fed by the WorkOS Events API.
//
// Returns the resolved organization (via resolveOrganization) if the user
// currently holds an *active* membership in it, otherwise null. Callers
// should treat null as "no access" and route accordingly (onboarding page /
// 403).

export const authorizeOrganization = (userId: string, organizationId: string) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const memberships = yield* workos.listUserMemberships(userId);
    const active = memberships.data.find(
      (m: { readonly organizationId: string; readonly status: string }) =>
        m.organizationId === organizationId && m.status === "active",
    );
    if (!active) return null;

    return yield* resolveOrganization(organizationId);
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
// live membership, so the worst a forged header does is name an org the caller
// already belongs to.
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
 * verified live via {@link authorizeOrganization}.
 */
export const authorizeOrganizationSelector = (userId: string, selector: string) =>
  Effect.gen(function* () {
    if (selector.startsWith("org_")) {
      return yield* authorizeOrganization(userId, selector);
    }
    const users = yield* UserStoreService;
    const org = yield* users.use((s) => s.getOrganizationBySlug(selector));
    if (!org) return null;
    return yield* authorizeOrganization(userId, org.id);
  });
