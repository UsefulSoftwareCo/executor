import * as Atom from "effect/unstable/reactivity/Atom";

import { AccountApiClient } from "./account-client";
import { ReactivityKey } from "./reactivity-keys";

// ---------------------------------------------------------------------------
// Account atoms — typed, cached, reactive queries/mutations over the shared
// `/account/*` surface. Used by the multiplayer shell, the API-keys page, and
// the org page. Provider-neutral: identical against cloud (WorkOS) and
// self-host (Better Auth).
// ---------------------------------------------------------------------------

// ── Identity ─────────────────────────────────────────────────────────────────

export const meAtom = AccountApiClient.query("account", "me", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.auth],
});

// ── API keys ───────────────────────────────────────────────────────────────

export const apiKeysAtom = AccountApiClient.query("account", "listApiKeys", {
  reactivityKeys: [ReactivityKey.apiKeys],
});

export const createApiKey = AccountApiClient.mutation("account", "createApiKey");
export const revokeApiKey = AccountApiClient.mutation("account", "revokeApiKey");

// ── Organization members ─────────────────────────────────────────────────────

export const orgMembersAtom = Atom.refreshOnWindowFocus(
  AccountApiClient.query("account", "listMembers", {
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.orgMembers],
  }),
);

export const orgRolesAtom = AccountApiClient.query("account", "listRoles", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.orgMembers],
});

export const inviteMember = AccountApiClient.mutation("account", "inviteMember");
export const removeMember = AccountApiClient.mutation("account", "removeMember");
export const updateMemberRole = AccountApiClient.mutation("account", "updateMemberRole");
export const updateOrgName = AccountApiClient.mutation("account", "updateOrgName");
