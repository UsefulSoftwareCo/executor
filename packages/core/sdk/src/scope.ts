import { Schema } from "effect";

import { ScopeId } from "./ids";

export const Scope = Schema.Struct({
  id: ScopeId,
  name: Schema.String,
  createdAt: Schema.Date,
});
export type Scope = typeof Scope.Type;

// ---------------------------------------------------------------------------
// User-org scope id — the per-user secret-isolation contract.
//
// A cloud/self-host executor's scope stack is `[userOrgScope, orgScope]`
// (innermost first). The inner scope id bakes the org into the user id so the
// same WorkOS user in a different org gets a distinct scope row, and per-user
// secrets/tokens written at this scope cannot leak to other members of the org.
//
// This id is produced by the host apps and *parsed* by the workos-vault plugin
// (to split it into per-field KEK context). Producer and parser MUST agree, so
// both reference the helpers below as the single source of truth. Do NOT change
// the string shape without updating every consumer in lockstep.
// ---------------------------------------------------------------------------

const USER_ORG_SCOPE_PREFIX = "user-org:";

// Mirrors the historical workos-vault regex `^user-org:([^:]+):([^:]+)$`:
// the `user-org:` prefix followed by exactly two colon-free, non-empty
// segments. Kept anchored to a const so the producer and parser cannot drift.
const USER_ORG_SCOPE_ID_REGEX = /^user-org:([^:]+):([^:]+)$/;

/**
 * Build the per-user-within-org scope id. The single source of truth for the
 * `user-org:${userId}:${organizationId}` string shape.
 */
export const userOrgScopeId = (userId: string, organizationId: string): string =>
  `${USER_ORG_SCOPE_PREFIX}${userId}:${organizationId}`;

/**
 * Inverse of {@link userOrgScopeId}. Returns the `{ userId, organizationId }`
 * pair for a user-org scope id, or `null` for any other scope shape.
 *
 * Behaviour is identical to the legacy workos-vault regex
 * `^user-org:([^:]+):([^:]+)$`: both segments are matched greedily as
 * colon-free, non-empty runs, so an id with extra colons (e.g.
 * `user-org:a:b:c`) or an empty segment does not match. userId/organizationId
 * may be otherwise opaque.
 */
export const parseUserOrgScopeId = (
  id: string,
): { readonly userId: string; readonly organizationId: string } | null => {
  const m = id.match(USER_ORG_SCOPE_ID_REGEX);
  if (!m) return null;
  return { userId: m[1]!, organizationId: m[2]! };
};

/**
 * Build the canonical `[userOrgScope, orgScope]` scope stack (innermost first)
 * shared by the cloud and self-host per-request executors. The inner scope is
 * named `Personal · ${organizationName}`; the outer scope is the bare org.
 *
 * Centralising this keeps the id shape and naming byte-identical across hosts
 * and in lockstep with {@link parseUserOrgScopeId}.
 */
export const makeUserOrgScopeStack = (
  userId: string,
  organizationId: string,
  organizationName: string,
): readonly [Scope, Scope] => {
  const createdAt = new Date();
  const userOrgScope = Scope.make({
    id: ScopeId.make(userOrgScopeId(userId, organizationId)),
    name: `Personal · ${organizationName}`,
    createdAt,
  });
  const orgScope = Scope.make({
    id: ScopeId.make(organizationId),
    name: organizationName,
    createdAt,
  });
  return [userOrgScope, orgScope];
};

/**
 * Source-add flows that do not expose a user-facing placement choice install
 * sources at the outermost visible scope. Local executors have one scope, while
 * cloud executors use an innermost personal scope plus an outer organization
 * scope where shared sources live.
 */
export const defaultSourceInstallScopeId = (
  scopes: readonly { readonly id: ScopeId | string }[],
): string | null => {
  const scope = scopes[scopes.length - 1];
  return scope ? String(scope.id) : null;
};
