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
 * Per-owner precision is intentionally dropped: a mutation under one owner
 * invalidating another owner's queries is harmless (the UI shows one owner at
 * a time) and keeps the convention ergonomic.
 */
export const ReactivityKey = {
  /** The integration catalog (was `sources`). */
  integrations: "integrations",
  tools: "tools",
  /** Owner-scoped credentials (was `secrets` + `connections`). */
  connections: "connections",
  /** Credential-provider discovery. */
  providers: "providers",
  policies: "policies",
  /** Registered OAuth clients (apps). */
  oauthClients: "oauth-clients",
  // cloud-only resources
  orgMembers: "org:members",
  orgDomains: "org:domains",
  orgInfo: "org:info",
  apiKeys: "api-keys",
  auth: "auth",
} as const;

/** Mutations that add/remove/refresh an integration also affect tool listings. */
export const integrationWriteKeys = [ReactivityKey.integrations, ReactivityKey.tools] as const;

/** Mutations that create / remove / refresh a connection. Touches `tools`
 *  because a connection's tools are produced per-connection — creating or
 *  refreshing a connection changes the tool catalog. */
export const connectionWriteKeys = [ReactivityKey.connections, ReactivityKey.tools] as const;

/** Mutations that register / replace an OAuth client (app). */
export const oauthClientWriteKeys = [ReactivityKey.oauthClients] as const;

/** Mutations that mutate tool policies. Also touches `tools` because
 *  `tools.list` filters blocked tools — adding/removing a `block`
 *  policy changes what the tools page shows. */
export const policyWriteKeys = [ReactivityKey.policies, ReactivityKey.tools] as const;

/** Cloud-only: org membership mutations. */
export const orgMemberWriteKeys = [ReactivityKey.orgMembers] as const;

/** Cloud-only: org domain mutations. */
export const orgDomainWriteKeys = [ReactivityKey.orgDomains] as const;

/** Cloud-only: org info mutations (name, etc.) — also touches auth. */
export const orgInfoWriteKeys = [ReactivityKey.orgInfo, ReactivityKey.auth] as const;

/** Cloud-only: user API key mutations. */
export const apiKeyWriteKeys = [ReactivityKey.apiKeys] as const;

/** Cloud-only: auth mutations (org switch/create) — invalidate everything user-visible. */
export const authWriteKeys = [
  ReactivityKey.auth,
  ReactivityKey.orgInfo,
  ReactivityKey.orgMembers,
  ReactivityKey.orgDomains,
] as const;
