import { AdminApiClient } from "./admin-client";

// ---------------------------------------------------------------------------
// Self-host admin atoms — typed, cached, reactive queries/mutations over the
// app-local /api/admin/* invite-code surface, on the same atom registry as the
// shared account atoms. Member management reuses the shared account atoms; only
// invite codes are new here.
// ---------------------------------------------------------------------------

// Local reactivity key: invites only matter within this client, so they don't
// belong in the shared cross-client ReactivityKey set.
const INVITES_KEY = "self-host:invites";

export const invitesAtom = AdminApiClient.query("admin", "listInvites", {
  reactivityKeys: [INVITES_KEY],
});

export const createInvite = AdminApiClient.mutation("admin", "createInvite");
export const revokeInvite = AdminApiClient.mutation("admin", "revokeInvite");

/** Mutations that change the invite list pass these at the call site. */
export const inviteWriteKeys = [INVITES_KEY] as const;
