// ---------------------------------------------------------------------------
// Who may see the admin sections.
//
// There are two independent gates and both are load-bearing:
//
//   1. NAV VISIBILITY (this file). The console has no role on the session —
//      `AccountMeResponse` carries a user and an organization, not a role — so
//      the only client-side role signal available today is the member list:
//      find the row flagged `isCurrentUser` and read its role. Cloud's org page
//      already derives its danger zone this way; this generalizes it.
//   2. ACCESS ITSELF (the page). The server decides. Every admin endpoint is
//      gated per host (cloud: an org API key or an admin-role session;
//      self-host: a Better Auth owner/admin), and the page renders a denied
//      state on 401/403 regardless of what this file concluded.
//
// The nav gate is a convenience, not security: it exists so a plain member
// isn't shown a section that would only refuse them. A member who guesses the
// URL hits gate 2, which is the real one.
// ---------------------------------------------------------------------------

/** Roles that may read the tenant-wide admin plane. Cloud (WorkOS) issues
 *  `admin` / `member`; self-host (Better Auth) issues `owner` / `admin` /
 *  `member`. Both hosts' admin middleware accept exactly this set. */
const TENANT_ADMIN_ROLES: ReadonlySet<string> = new Set(["admin", "owner"]);

/** A member row as `/account/members` returns it, typed structurally. */
export interface TenantMemberRow {
  readonly role: string;
  readonly status: string;
  readonly isCurrentUser: boolean;
}

/**
 * Whether the current member may read the admin plane, per the member list.
 *
 * Only an ACTIVE membership counts: a pending invite carries a role but no
 * access yet, and treating it as admin would show a section the server refuses.
 * A list with no `isCurrentUser` row (self-host before the org is populated, a
 * host that doesn't serve members) is not an admin — the safe default, since
 * the page's own denied state is the honest surface for that case.
 */
export const isTenantAdminMember = (members: readonly TenantMemberRow[]): boolean =>
  members.some(
    (member) =>
      member.isCurrentUser && member.status === "active" && TENANT_ADMIN_ROLES.has(member.role),
  );

/** Workspace connection creation is unrestricted on single-user hosts.
 * Organization hosts require the active member to be an admin or owner;
 * Personal connection creation remains available to every active member. */
export const canCreateWorkspaceConnectionsForHost = (
  organizationId: string | null,
  isTenantAdmin: boolean,
): boolean => organizationId === null || isTenantAdmin;
