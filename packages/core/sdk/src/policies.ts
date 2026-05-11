// ---------------------------------------------------------------------------
// Tool policies — pattern matcher + policy resolution. Pure functions; the
// executor stitches them into `tools.list`, `tools.invoke`, and the public
// `executor.policies` CRUD surface. Plugins consume the same surface.
// ---------------------------------------------------------------------------

import { Match, Schema } from "effect";

import type { ToolPolicyAction, ToolPolicyRow } from "./core-schema";
import { PolicyId, ScopeId } from "./ids";

// ---------------------------------------------------------------------------
// Public projection — what callers see when they list policies. Strips the
// raw `scope_id` to a readable `scopeId`, hides `created_at` typing
// inconsistencies between adapters, and re-tags `id` as a `PolicyId`.
// ---------------------------------------------------------------------------

export interface ToolPolicy {
  readonly id: PolicyId;
  readonly scopeId: ScopeId;
  readonly pattern: string;
  readonly action: ToolPolicyAction;
  /** Fractional-indexing key. Lower lex order = higher precedence.
   *  Use `generateKeyBetween(a, b)` from the `fractional-indexing`
   *  package to produce a key that sits between two existing rows. */
  readonly position: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateToolPolicyInput {
  readonly targetScope: string;
  readonly pattern: string;
  readonly action: ToolPolicyAction;
  /** Optional explicit position. Defaults to a key above the current
   *  minimum (top of the scope's list; highest precedence). */
  readonly position?: string;
}

export interface UpdateToolPolicyInput {
  readonly id: string;
  readonly targetScope: string;
  readonly pattern?: string;
  readonly action?: ToolPolicyAction;
  readonly position?: string;
}

export interface RemoveToolPolicyInput {
  readonly id: string;
  readonly targetScope: string;
}

// ---------------------------------------------------------------------------
// Match result — what `resolveToolPolicy` returns when a rule fires. Carries
// the matched pattern so error messages and approval prompts can show the
// user *which* rule produced the gate ("matched policy: vercel.dns.*").
// ---------------------------------------------------------------------------

export interface PolicyMatch {
  readonly action: ToolPolicyAction;
  readonly pattern: string;
  readonly policyId: string;
}

// ---------------------------------------------------------------------------
// Effective policy — the single answer to "what happens when this tool is
// invoked?". Combines the user policy layer with the plugin's default
// `requiresApproval` annotation. Callers (UI, agents, telemetry) shouldn't
// need to know the layering — they ask once and render one thing.
//
// `source` distinguishes user-authored rules from plugin-derived defaults
// purely for display ("Matched: vercel.*" vs "Plugin default"). The
// `action` is what actually drives behavior at invoke time.
// ---------------------------------------------------------------------------

export type PolicySource = "user" | "plugin-default";

export interface EffectivePolicy {
  readonly action: ToolPolicyAction;
  readonly source: PolicySource;
  /** Matched pattern; populated only when `source === "user"`. */
  readonly pattern?: string;
  /** Policy row id; populated only when `source === "user"`. */
  readonly policyId?: string;
}

// ---------------------------------------------------------------------------
// Pattern matching. v1 grammar:
//   - universal:    `*`                     matches every tool id
//   - exact:        `vercel.dns.create`     matches only that id
//   - subtree:      `vercel.dns.*`          matches anything starting with `vercel.dns.`
//   - plugin-wide:  `vercel.*`              matches anything starting with `vercel.`
// `*` is only meaningful as a complete trailing segment (or as the
// entire pattern). Patterns without a wildcard are exact-id matches.
// ---------------------------------------------------------------------------

export const matchPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  if (pattern === toolId) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    if (prefix.length === 0) return false;
    return toolId === prefix || toolId.startsWith(`${prefix}.`);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Pattern validation — rejects shapes the matcher can't handle. Used by the
// CRUD path so a malformed rule never lands in the table.
// ---------------------------------------------------------------------------

export const isValidPattern = (pattern: string): boolean => {
  if (pattern.length === 0) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith(".") || pattern.endsWith(".")) return false;
  if (pattern.includes("..")) return false;
  if (pattern.startsWith("*")) return false;
  // `*` is only valid as the entire trailing segment.
  const segments = pattern.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.length === 0) return false;
    if (seg.includes("*") && seg !== "*") return false;
    if (seg === "*" && i !== segments.length - 1) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Resolution — each scope contributes its first matching rule by local
// position. The final answer is the most restrictive matched action across
// those scopes, so an inner preference cannot weaken an outer guardrail.
// Caller passes a `scopeRank` function so the resolver doesn't need to know
// the executor's scope stack shape.
// ---------------------------------------------------------------------------

// Lex compare on fractional-indexing key, then id as a stable tiebreak.
// Two rows with identical `position` (racing inserts that picked the same
// `generateKeyBetween(null, min)` from independent clients) would otherwise
// flip on every refetch.
export const comparePolicyRow = (
  a: Pick<ToolPolicyRow, "position" | "id">,
  b: Pick<ToolPolicyRow, "position" | "id">,
): number => {
  const pa = a.position;
  const pb = b.position;
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  const ia = a.id;
  const ib = b.id;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};

const actionRestrictionRank = (action: ToolPolicyAction): number =>
  Match.value(action).pipe(
    Match.when("block", () => 3),
    Match.when("require_approval", () => 2),
    Match.when("approve", () => 1),
    Match.exhaustive,
  );

const moreRestrictive = <T extends { readonly action: ToolPolicyAction }>(
  current: T | undefined,
  candidate: T,
): T => {
  if (!current) return candidate;
  const currentRank = actionRestrictionRank(current.action);
  const candidateRank = actionRestrictionRank(candidate.action);
  return candidateRank > currentRank ? candidate : current;
};

export const resolveToolPolicy = (
  toolId: string,
  policies: readonly ToolPolicyRow[],
  scopeRank: (row: Pick<ToolPolicyRow, "scope_id">) => number,
): PolicyMatch | undefined => {
  if (policies.length === 0) return undefined;
  const sorted = [...policies].sort((a, b) => {
    const sa = scopeRank(a);
    const sb = scopeRank(b);
    if (sa !== sb) return sa - sb;
    return comparePolicyRow(a, b);
  });
  const firstMatchByScope = new Map<string, PolicyMatch>();
  for (const row of sorted) {
    if (firstMatchByScope.has(row.scope_id)) continue;
    if (matchPattern(row.pattern, toolId)) {
      firstMatchByScope.set(row.scope_id, {
        action: row.action as ToolPolicyAction,
        pattern: row.pattern,
        policyId: row.id,
      });
    }
  }
  let selected: PolicyMatch | undefined;
  for (const match of firstMatchByScope.values()) {
    selected = moreRestrictive(selected, match);
  }
  return selected;
};

// ---------------------------------------------------------------------------
// Layered resolution — one call returns the effective policy combining
// user-authored rules and the plugin's default `requiresApproval`
// annotation. Use this anywhere a UI / agent / log needs the final answer
// without knowing about the layering.
//
// Two flavors:
//   - `resolveEffectivePolicy` takes raw rows + a scopeRank, mirrors
//      `resolveToolPolicy`. Used server-side.
//   - `effectivePolicyFromSorted` takes a pre-sorted list of public
//      `ToolPolicy` projections; for clients that already received
//      policies in evaluation order from the API.
// ---------------------------------------------------------------------------

const liftPlugin = (defaultRequiresApproval: boolean | undefined): EffectivePolicy =>
  defaultRequiresApproval
    ? { action: "require_approval", source: "plugin-default" }
    : { action: "approve", source: "plugin-default" };

const liftUser = (match: PolicyMatch): EffectivePolicy => ({
  action: match.action,
  source: "user",
  pattern: match.pattern,
  policyId: match.policyId,
});

export const resolveEffectivePolicy = (
  toolId: string,
  policies: readonly ToolPolicyRow[],
  scopeRank: (row: Pick<ToolPolicyRow, "scope_id">) => number,
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  const match = resolveToolPolicy(toolId, policies, scopeRank);
  return match ? liftUser(match) : liftPlugin(defaultRequiresApproval);
};

export const effectivePolicyFromSorted = (
  toolId: string,
  sortedPolicies: readonly (Pick<ToolPolicy, "pattern" | "action" | "id"> &
    Partial<Pick<ToolPolicy, "scopeId">>)[],
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  const firstMatchByScope = new Map<string, EffectivePolicy>();
  for (const p of sortedPolicies) {
    const scopeKey = "scopeId" in p && p.scopeId ? String(p.scopeId) : "__flat__";
    if (firstMatchByScope.has(scopeKey)) continue;
    if (matchPattern(p.pattern, toolId)) {
      firstMatchByScope.set(scopeKey, {
        action: p.action,
        source: "user",
        pattern: p.pattern,
        policyId: p.id,
      });
    }
  }
  let selected: EffectivePolicy | undefined;
  for (const match of firstMatchByScope.values()) {
    selected = moreRestrictive(selected, match);
  }
  return selected ?? liftPlugin(defaultRequiresApproval);
};

// ---------------------------------------------------------------------------
// Row → public projection.
// ---------------------------------------------------------------------------

export const rowToToolPolicy = (row: ToolPolicyRow): ToolPolicy => ({
  id: PolicyId.make(row.id),
  scopeId: ScopeId.make(row.scope_id),
  pattern: row.pattern,
  action: row.action as ToolPolicyAction,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// ---------------------------------------------------------------------------
// Schema for the action enum — useful for HTTP edges that want to validate
// inputs with effect/Schema.
// ---------------------------------------------------------------------------

export const ToolPolicyActionSchema = Schema.Literals(["approve", "require_approval", "block"]);
