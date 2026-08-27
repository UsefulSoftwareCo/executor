import type { HealthStatus, IntegrationSlug, Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Pure display logic for the admin Users section.
//
// Everything here is a plain function over wire data so it can be tested
// without mounting the console (the package's testing doctrine: extract the
// logic, test the logic). The components below it only arrange the results.
// ---------------------------------------------------------------------------

/** The connection shape the admin plane returns (`AdminUserConnection`), typed
 *  structurally so these helpers don't depend on the schema module. */
export interface AdminConnectionRow {
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly name: string;
  readonly oauthScope: string | null;
  readonly lastHealth: { readonly status: HealthStatus } | null;
}

// ── Last seen ───────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative "last seen", phrased no more precisely than the field deserves.
 *
 * The writer throttles `lastSeenAt` to roughly an hour, so a sub-hour delta is
 * NOT evidence the user was here five minutes ago — it only means the sighting
 * landed within the last throttle window. Everything under an hour therefore
 * collapses to one honest bucket instead of counting minutes, and `null` (never
 * seen on a request — a user earns a row at connection-create, before any
 * sighting) reads as "Never", not "unknown".
 */
export const formatLastSeen = (lastSeenAt: number | null, now: number = Date.now()): string => {
  if (lastSeenAt === null) return "Never";
  const delta = now - lastSeenAt;
  if (delta < HOUR) return "Within the hour";
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return hours === 1 ? "About 1 hour ago" : `About ${hours} hours ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days === 1) return "About 1 day ago";
  if (days < 30) return `About ${days} days ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(lastSeenAt));
};

/** The tooltip behind {@link formatLastSeen}: the exact recorded instant plus
 *  the coarseness caveat, so an operator reading "Within the hour" can see what
 *  the row actually stores. */
export const lastSeenTitle = (lastSeenAt: number | null): string =>
  lastSeenAt === null
    ? "Never seen on a request"
    : `Recorded ${new Date(lastSeenAt).toLocaleString()} — updated at most once an hour`;

/** Absolute date, for the created column. */
export const formatAdminDate = (epochMs: number): string =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(epochMs),
  );

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * How a user's opaque `externalId` is shown.
 *
 * The id is opaque by contract — nothing may parse it — so it is rendered whole,
 * in mono, and only visually shortened when it is long enough to break the
 * column. The full value stays available via the title attribute and the copy
 * button. `"local"` is a host sentinel for the single-player subject and reads
 * better spelled out.
 */
export const LOCAL_SUBJECT_ID = "local";

export const isLocalSubject = (externalId: string): boolean => externalId === LOCAL_SUBJECT_ID;

/** Visual truncation only — never a parse. Keeps both ends so two ids that
 *  differ in the middle stay distinguishable. */
export const shortenExternalId = (externalId: string, max = 28): string => {
  if (externalId.length <= max) return externalId;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${externalId.slice(0, head)}…${externalId.slice(externalId.length - tail)}`;
};

/** The identity half of a user row, as the admin plane reports it. Both fields
 *  are independently nullable: the host resolved one, the other, or neither. */
export interface AdminUserIdentityRow {
  readonly externalId: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
}

/**
 * How one user is titled and subtitled.
 *
 * The primary line is whatever an operator would actually recognize — the email
 * first, since that is what they invite, search and support against; the
 * display name only when there is no email; and the id itself when the host
 * resolved neither. The secondary line carries the `externalId` whenever the
 * primary line is NOT already the id, so the opaque principal is always one
 * glance away without ever being the headline for a user who has a name.
 *
 * When identity is absent the result is exactly the pre-identity rendering — one
 * mono id line and no subtitle — so an unresolvable row (a member who left the
 * org while their connections remain, a host sentinel like "local", a directory
 * outage) degrades to what this table always showed rather than to a gap.
 *
 * `primaryIsId` is what tells the component which line gets mono/metadata
 * styling, so the caller never has to re-derive the same decision.
 */
export interface AdminUserTitle {
  readonly primary: string;
  readonly secondary: string | null;
  readonly primaryIsId: boolean;
}

export const adminUserTitle = (user: AdminUserIdentityRow): AdminUserTitle => {
  const email = user.email?.trim();
  const displayName = user.displayName?.trim();
  const idLabel = isLocalSubject(user.externalId) ? LOCAL_SUBJECT_ID : user.externalId;
  const named = email || displayName;
  if (!named) return { primary: idLabel, secondary: null, primaryIsId: true };
  return { primary: named, secondary: idLabel, primaryIsId: false };
};

/** The email an operator can copy off a row, or `null` when the host resolved
 *  none. Deliberately NOT the display name: a name is not an address, and a
 *  copy button that yields something unusable is worse than no button. */
export const adminUserCopyableEmail = (user: AdminUserIdentityRow): string | null => {
  const email = user.email?.trim();
  return email ? email : null;
};

// ── Connections ─────────────────────────────────────────────────────────────

/** The health status a row displays. A connection that was never probed carries
 *  no verdict, which is `unknown` in the shared vocabulary. */
export const connectionHealthStatus = (connection: AdminConnectionRow): HealthStatus =>
  connection.lastHealth?.status ?? "unknown";

/** The catalog row this view needs: the slug it marks, plus the `kind` that
 *  says whether connecting is even a thing one can do to it. Structural so
 *  these helpers stay independent of the catalog schema module. */
export interface AdminCatalogRow {
  readonly slug: IntegrationSlug;
  readonly kind: string;
}

/** The built-in integration's reserved slug. `kind` is the general signal, but
 *  the product page pins the slug too, so this mirrors it exactly. */
const BUILT_IN_INTEGRATION_SLUG = "executor";

/**
 * Whether an integration has a connect flow at all.
 *
 * Deliberately NOT "declares no auth methods": an openapi/mcp/graphql
 * integration can carry `authMethods: []` and still be connectable, because its
 * accounts panel passes `createCustomMethod` and the user defines the method
 * themselves (`accounts-section.tsx`: `canAddConnection = methods.length > 0 ||
 * createCustomMethod !== undefined`). Empty auth methods therefore means "no
 * method declared yet", not "cannot be connected".
 *
 * The real gate is the one the product's integration detail page applies before
 * any of that — `integration-detail.tsx`: `isBuiltInIntegration = namespace ===
 * "executor" || integrationData?.kind === "built-in"`, which removes the whole
 * Accounts tab rather than merely disabling a button. A built-in integration is
 * a plugin-declared static source with a synthetic connection and no
 * credential: there is nothing to connect and no flow to send anyone to.
 */
export const isConnectableIntegration = (row: AdminCatalogRow): boolean =>
  row.kind !== "built-in" && String(row.slug) !== BUILT_IN_INTEGRATION_SLUG;

/**
 * The available-vs-connected view for one user: every *connectable* integration
 * in the tenant's catalog, marked with whether this user has connected it.
 *
 * "Available" is the catalog, so an integration nobody has connected still gets
 * a (greyed) slot — that absence is the point of the view. Sorted connected
 * first so a dense grid leads with signal, then by slug for a stable order
 * across users.
 *
 * Non-connectable integrations are dropped entirely — from the slots, from the
 * counts, and from the connect links. Listing the built-in under "not
 * connected" would invite an admin to send a link to a flow that doesn't exist.
 * The one exception is data honesty: if a user somehow HOLDS a connection on
 * one, it is reported as connected rather than hidden.
 *
 * Org-owned connections are deliberately excluded from the API's per-user
 * results, so anything appearing here is genuinely this user's own.
 */
export interface IntegrationConnectionState {
  readonly integration: IntegrationSlug;
  readonly connected: boolean;
  readonly connections: readonly AdminConnectionRow[];
}

export const integrationConnectionStates = (
  catalog: readonly AdminCatalogRow[],
  connections: readonly AdminConnectionRow[],
): readonly IntegrationConnectionState[] => {
  const byIntegration = new Map<IntegrationSlug, AdminConnectionRow[]>();
  for (const connection of connections) {
    const existing = byIntegration.get(connection.integration);
    if (existing) existing.push(connection);
    else byIntegration.set(connection.integration, [connection]);
  }
  // A user can hold a connection on an integration the catalog read didn't
  // return (a catalog the viewer can't see, or one removed since). Showing it
  // as connected is more honest than dropping the user's own credential — and
  // an unknown slug is assumed connectable, since only the catalog can say
  // otherwise.
  const slugs = new Set<IntegrationSlug>([
    ...catalog.filter(isConnectableIntegration).map((row) => row.slug),
    ...byIntegration.keys(),
  ]);
  return [...slugs]
    .map((integration) => ({
      integration,
      connected: byIntegration.has(integration),
      connections: byIntegration.get(integration) ?? [],
    }))
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.integration.localeCompare(b.integration);
    });
};

// ── Connect links ───────────────────────────────────────────────────────────

/**
 * The connect deep link for an integration, as an absolute URL for THIS
 * deployment — something an admin can paste to a user who needs to connect.
 *
 * The org segment is load-bearing and must be the SENDING admin's org. A
 * recipient who belongs to several orgs would otherwise land in whichever one
 * their session defaults to and connect the credential in the wrong workspace —
 * silently, since the flow itself would succeed. The admin page is org-scoped,
 * so the correct org is known at the call site and is carried in the link
 * rather than left to the recipient's session to guess.
 *
 * The slug is optional because the route's `{-$orgSlug}` segment is: a host that
 * renders no segment yields the bare `/connect/<slug>` form, which is the whole
 * route there. (Both cloud and self-host do canonicalize onto a slug in
 * practice — self-host onto `default` — so the prefixed form is the common
 * case.) It is rendered as a copyable URL rather than an in-console link
 * because it targets the recipient's session, not the admin's.
 */
export const connectLinkUrl = (
  integration: IntegrationSlug,
  origin: string,
  orgSlug?: string | undefined,
): string => {
  const base = origin.replace(/\/+$/, "");
  const org = orgSlug?.trim();
  return org ? `${base}/${org}/connect/${integration}` : `${base}/connect/${integration}`;
};

// ── Audit activity ─────────────────────────────────────────────────────────

export interface AdminAuditActorRow {
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly actorDisplayName: string | null;
}

/** Human-readable actor, with the stable id retained as the final fallback. */
export const adminAuditActorLabel = (event: AdminAuditActorRow): string =>
  event.actorEmail ?? event.actorDisplayName ?? event.actorId ?? "System";

export const adminAuditResourceLabel = (event: {
  readonly resourceType: "connection" | "integration" | "oauth_client";
  readonly resourceParent: string | null;
  readonly resourceId: string;
}): string => {
  const kind =
    event.resourceType === "oauth_client"
      ? "OAuth app"
      : event.resourceType === "integration"
        ? "Integration"
        : "Connection";
  const identifier = event.resourceParent
    ? `${event.resourceParent} / ${event.resourceId}`
    : event.resourceId;
  return `${kind}: ${identifier}`;
};

export const adminAuditScopeLabel = (owner: Owner | null): string =>
  owner === "user" ? "Personal" : "Workspace";

// ── Paging ──────────────────────────────────────────────────────────────────

/**
 * Split an over-fetched page into the rows to render plus whether another page
 * exists. The contract returns no total count, so "is there a next page" is
 * answered by asking for one row more than the page holds.
 */
export const splitPage = <A>(
  rows: readonly A[],
  pageSize: number,
): { readonly rows: readonly A[]; readonly hasNext: boolean } => ({
  rows: rows.slice(0, pageSize),
  hasNext: rows.length > pageSize,
});

/** The 1-based page number an offset lands on, for the mono pager label. */
export const pageNumber = (offset: number, pageSize: number): number =>
  Math.floor(offset / pageSize) + 1;
