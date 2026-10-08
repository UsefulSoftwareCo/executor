import { Effect } from "effect";

import { isPrivileged } from "../admin/require-admin";
import type { BetterAuthHandle } from "./better-auth";

// ---------------------------------------------------------------------------
// The one membership read every authenticated self-host request makes.
//
// A credential (session cookie, bearer session token, API key, mcp() OAuth
// access token) proves WHO the caller is. It does not prove the caller still
// belongs to the instance organization: removing a member deletes the `member`
// row and nothing else, so every session, key and token the removed user holds
// keeps resolving to a user. Membership is therefore read from the row on
// every request, after the credential resolves, and a missing row denies the
// request. There is no cache: a removed member is refused on the very next
// request, and re-adding them restores access on the next request too.
//
// This is the same `(userId, organizationId)` row the organization plugin's
// `getActiveMemberRole` endpoint answers from, read through Better Auth's own
// adapter so the OAuth seam (which holds no session headers) can share it. One
// direct read per request, shared by the API, MCP, account and approval planes.
// ---------------------------------------------------------------------------

export type InstanceOrgRole = "admin" | "member";

export interface InstanceMembership {
  /** Workspace-write authority, from the row's role (`owner`/`admin` -> admin). */
  readonly role: InstanceOrgRole;
}

/**
 * The caller's current membership in the instance organization, or `null`
 * when there is none. A lookup failure also answers `null`: every caller
 * treats `null` as a denial, so an infrastructure fault refuses the request
 * rather than admitting it.
 */
export const findInstanceMembership = (
  betterAuth: BetterAuthHandle,
  userId: string,
  organizationId: string,
): Effect.Effect<InstanceMembership | null> =>
  Effect.tryPromise(async () => {
    const context = await betterAuth.auth.$context;
    return context.adapter.findOne<{ readonly role?: string | null }>({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "organizationId", value: organizationId },
      ],
    });
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((row): InstanceMembership | null =>
      row ? { role: row.role != null && isPrivileged(row.role) ? "admin" : "member" } : null,
    ),
    Effect.withSpan("selfhost.identity.membership"),
  );
