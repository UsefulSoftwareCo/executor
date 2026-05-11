/**
 * Canonical reactivity keys for query/mutation invalidation.
 *
 * effect-atom's `Reactivity` service refreshes any query whose `reactivityKeys`
 * overlap with a completed mutation's `reactivityKeys`. The Reactivity instance
 * is shared across the global Atom registry, so keys interop across plugin
 * clients (`McpClient`, `OpenApiClient`, `ExecutorApiClient`, …).
 *
 * Conventions:
 *   - Every query that reads a server resource sets `reactivityKeys` at the
 *     query atom's definition site.
 *   - Every mutation passes `reactivityKeys` at the call site (mutations don't
 *     accept the option at definition time — see effect-atom AtomHttpApi).
 *   - Use the constants below; do not invent ad-hoc string keys at call sites.
 *
 * Per-scope precision is intentionally dropped: a mutation in one scope
 * invalidating another scope's queries is harmless (users see one scope at a
 * time) and keeps the convention ergonomic.
 */
export const ReactivityKey = {
  sources: "sources",
  tools: "tools",
  secrets: "secrets",
  connections: "connections",
  scope: "scope",
  policies: "policies",
  // cloud-only resources
  orgMembers: "org:members",
  orgDomains: "org:domains",
  orgInfo: "org:info",
  apiKeys: "api-keys",
  auth: "auth",
} as const;

/** Mutations that add/remove/refresh a source also affect tool listings. */
export const sourceWriteKeys = [ReactivityKey.sources, ReactivityKey.tools] as const;

/** Mutations that mint or revoke secrets. */
export const secretWriteKeys = [ReactivityKey.secrets] as const;

/** Mutations that create or remove connections. Touches `secrets` too
 *  because connection-owned secret rows are filtered out of the secrets
 *  list — signing out should unhide them (in the future) or remove
 *  them, and either way the secrets page needs to re-query. */
export const connectionWriteKeys = [ReactivityKey.connections, ReactivityKey.secrets] as const;

/** Mutations that change scope membership/info. */
export const scopeWriteKeys = [ReactivityKey.scope] as const;

/** Mutations that mutate tool policies. Also touches `tools` because
 *  `tools.list` filters blocked tools — adding/removing a `block`
 *  policy changes what the tools page shows. */
export const policyWriteKeys = [ReactivityKey.policies, ReactivityKey.tools] as const;

/** Cloud-only: org membership mutations. */
export const orgMemberWriteKeys = [ReactivityKey.orgMembers] as const;

/** Cloud-only: org domain mutations. */
export const orgDomainWriteKeys = [ReactivityKey.orgDomains] as const;

/** Cloud-only: org info mutations (name, etc.) — also touches scope/auth. */
export const orgInfoWriteKeys = [ReactivityKey.orgInfo, ReactivityKey.auth] as const;

/** Cloud-only: user API key mutations. */
export const apiKeyWriteKeys = [ReactivityKey.apiKeys] as const;

/** Cloud-only: auth mutations (org switch/create) — invalidate everything user-visible. */
export const authWriteKeys = [
  ReactivityKey.auth,
  ReactivityKey.orgInfo,
  ReactivityKey.orgMembers,
  ReactivityKey.orgDomains,
  ReactivityKey.scope,
] as const;
