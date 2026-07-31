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

// `refreshOnWindowFocus` is BROWSER-ONLY: its signal atom subscribes to
// `window`/`document.visibilityState` the first time the atom is read, so
// evaluating it on a server throws `ReferenceError: window is not defined` —
// synchronously, in render, where no Suspense boundary can absorb it.
//
// `withServerValueInitial` gives the atom an explicit server snapshot
// (`AsyncResult.initial(true)`) that `useAtomValue`'s `getServerSnapshot` reads
// INSTEAD of evaluating the atom, so the read function never runs server-side.
// Every reader already handles the initial state (it is the ordinary loading
// state), and the client refetches on mount. Without this, any SSR'd tree that
// reads the member list — cloud's shell does, to decide the admin nav — fails
// the whole document render.
export const orgMembersAtom = Atom.withServerValueInitial(
  Atom.refreshOnWindowFocus(
    AccountApiClient.query("account", "listMembers", {
      timeToLive: "30 seconds",
      reactivityKeys: [ReactivityKey.orgMembers],
    }),
  ),
);

export const orgRolesAtom = AccountApiClient.query("account", "listRoles", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.orgMembers],
});

export const inviteMember = AccountApiClient.mutation("account", "inviteMember");
export const removeMember = AccountApiClient.mutation("account", "removeMember");
export const updateMemberRole = AccountApiClient.mutation("account", "updateMemberRole");
export const updateOrgName = AccountApiClient.mutation("account", "updateOrgName");
