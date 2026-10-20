import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import {
  DelegationScope,
  DelegationChallengeResponse,
  DelegationScopeOptionsResponse,
} from "@executor-js/api";

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

// ── Org API keys ────────────────────────────────────────────────────────────

// Admin-gated on the server (403 for a plain member) and refused entirely on
// self-host. The page only reads this atom for an admin on a host that mints
// org keys, so a failure here renders as the section's error state, not as a
// role probe.
export const orgApiKeysAtom = AccountApiClient.query("account", "listOrgApiKeys", {
  reactivityKeys: [ReactivityKey.orgApiKeys],
});

export const createOrgApiKey = AccountApiClient.mutation("account", "createOrgApiKey");
export const revokeOrgApiKey = AccountApiClient.mutation("account", "revokeOrgApiKey");

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

// ── Delegated credentials ───────────────────────────────────────────────────

export const delegatedCredentialsAtom = AccountApiClient.query(
  "account",
  "listDelegatedCredentials",
  {
    query: {},
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.delegatedCredentials],
  },
);

export const delegatedCredentialsOptimisticAtom = Atom.optimistic(delegatedCredentialsAtom);

export const delegationTargetsAtom = AccountApiClient.query("account", "listDelegationTargets", {
  timeToLive: "1 minute",
  reactivityKeys: [ReactivityKey.delegatedCredentials],
});

/** Target-scoped, human-readable choices for exact delegation consent. The
 * `self` key intentionally omits `targetId`, preserving self-target semantics
 * at the HTTP boundary. */
export const delegationScopeOptionsAtom = Atom.family((targetKey: string) =>
  AccountApiClient.query("account", "listDelegationScopeOptions", {
    query: targetKey === "self" ? {} : { targetId: targetKey },
    timeToLive: "30 seconds",
    reactivityKeys: [
      ReactivityKey.delegatedCredentials,
      ReactivityKey.policies,
      ReactivityKey.connections,
    ],
  }),
);

export const delegationAuditAtom = AccountApiClient.query("account", "listDelegationAudit", {
  query: {},
  timeToLive: "15 seconds",
  reactivityKeys: [ReactivityKey.delegationAudit],
});

export const delegationNotificationsAtom = AccountApiClient.query(
  "account",
  "listDelegationNotifications",
  {
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.delegatedCredentials],
  },
);

export const markDelegationNotificationRead = AccountApiClient.mutation(
  "account",
  "markDelegationNotificationRead",
);

type DelegationChallenge = typeof DelegationChallengeResponse.Type;
type DelegationScopeValue = typeof DelegationScope.Type;
export type DelegationScopeOptions = typeof DelegationScopeOptionsResponse.Type;
const emptyDelegationChallengeAtom = Atom.make<DelegationChallenge | null, never>(
  Effect.succeed(null),
);

export const delegationChallengeAtom = Atom.family((challengeId: string) =>
  challengeId.length === 0
    ? emptyDelegationChallengeAtom
    : Atom.mapResult(
        AccountApiClient.query("account", "getDelegationChallenge", {
          params: { challengeId },
          timeToLive: "5 seconds",
          reactivityKeys: [ReactivityKey.delegatedCredentials],
        }),
        (value): DelegationChallenge | null => value,
      ),
);

export const createDelegatedKey = AccountApiClient.mutation("account", "createDelegatedKey");
export const startDelegationChallenge = AccountApiClient.mutation(
  "account",
  "startDelegationChallenge",
);
export const completeDelegationProof = AccountApiClient.mutation(
  "account",
  "completeDelegationProof",
);
export const consentDelegationChallenge = AccountApiClient.mutation(
  "account",
  "consentDelegationChallenge",
);
export const consentDelegatedCredential = AccountApiClient.mutation(
  "account",
  "consentDelegatedCredential",
);
export const rotateDelegatedKey = AccountApiClient.mutation("account", "rotateDelegatedKey");
export const revokeDelegatedCredential = AccountApiClient.mutation(
  "account",
  "revokeDelegatedCredential",
);
export const revokeAllDelegatedCredentials = AccountApiClient.mutation(
  "account",
  "revokeAllDelegatedCredentials",
);

export const revokeDelegatedCredentialOptimistic = delegatedCredentialsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (current, arg: { readonly params: { readonly credentialId: string } }) =>
      AsyncResult.map(current, (response) => ({
        ...response,
        credentials: response.credentials.map((credential) =>
          credential.id === arg.params.credentialId
            ? {
                ...credential,
                lifecycle: {
                  status: "revoked" as const,
                  expiresAt: credential.lifecycle.expiresAt,
                  revokedAt: new Date().toISOString(),
                  revokeReason: "revoked",
                },
              }
            : credential,
        ),
      })),
    fn: revokeDelegatedCredential,
  }),
);

export const revokeAllDelegatedCredentialsOptimistic = delegatedCredentialsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly payload: {
          readonly target:
            | { readonly kind: "self" }
            | { readonly kind: "verified-human"; readonly id: string };
        };
      },
    ) =>
      AsyncResult.map(current, (response) => ({
        ...response,
        credentials: response.credentials.map((credential) => {
          const matches =
            arg.payload.target.kind === "self"
              ? credential.target.isCurrentUser
              : credential.target.id === arg.payload.target.id;
          return matches
            ? {
                ...credential,
                lifecycle: {
                  status: "revoked" as const,
                  expiresAt: credential.lifecycle.expiresAt,
                  revokedAt: new Date().toISOString(),
                  revokeReason: "subject-revoked",
                },
              }
            : credential;
        }),
      })),
    fn: revokeAllDelegatedCredentials,
  }),
);

export const consentDelegatedCredentialOptimistic = delegatedCredentialsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly params: { readonly credentialId: string };
        readonly payload: {
          readonly scope: DelegationScopeValue;
          readonly expiresAt: string;
        };
      },
    ) =>
      AsyncResult.map(current, (response) => ({
        ...response,
        credentials: response.credentials.map((credential) =>
          credential.id === arg.params.credentialId
            ? {
                ...credential,
                scope: arg.payload.scope,
                lifecycle: { ...credential.lifecycle, expiresAt: arg.payload.expiresAt },
              }
            : credential,
        ),
      })),
    fn: consentDelegatedCredential,
  }),
);
