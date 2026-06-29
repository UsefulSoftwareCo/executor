// ---------------------------------------------------------------------------
// Tool policies — pattern matcher + policy resolution. Pure functions; the
// executor stitches them into `tools.list`, `execute`, and the public
// `executor.policies` CRUD surface. Plugins consume the same surface.
//
// v2: policies are owner-scoped (org | user) instead of scope-stacked. Each
// owner contributes its first matching rule by local position; the final answer
// is the most restrictive matched action across owners, so a user preference
// cannot weaken an org guardrail (org = outer, user = inner).
// ---------------------------------------------------------------------------

import { Match, Schema } from "effect";

import type { ToolPolicyAction, ToolPolicyRow } from "./core-schema";
import { Owner, PolicyId } from "./ids";

export interface ToolPolicy {
  readonly id: PolicyId;
  readonly owner: Owner;
  readonly pattern: string;
  readonly action: ToolPolicyAction;
  /** Fractional-indexing key. Lower lex order = higher precedence. */
  readonly position: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateToolPolicyInput {
  readonly owner: Owner;
  readonly pattern: string;
  /** Optional explicit position. Defaults to a key above the current minimum
   *  (top of the owner's list; highest precedence). */
  readonly action: ToolPolicyAction;
  readonly position?: string;
}

export interface UpdateToolPolicyInput {
  readonly id: string;
  readonly owner: Owner;
  readonly pattern?: string;
  readonly action?: ToolPolicyAction;
  readonly position?: string;
}

export interface RemoveToolPolicyInput {
  readonly id: string;
  readonly owner: Owner;
}

// ---------------------------------------------------------------------------
// Match result.
// ---------------------------------------------------------------------------

export interface PolicyMatch {
  readonly action: ToolPolicyAction;
  readonly pattern: string;
  readonly policyId: string;
}

export type PolicySource = "user" | "plugin-default";

export interface EffectivePolicy {
  readonly action: ToolPolicyAction;
  readonly source: PolicySource;
  readonly pattern?: string;
  readonly policyId?: string;
}

// ---------------------------------------------------------------------------
// Pattern matching. Grammar (matched against the full tool address
// `<integration>.<owner>.<connection>.<tool>` or a shorter form the executor
// passes in):
//   - universal:        `*`
//   - exact:            `vercel.dns.create`
//   - subtree (trailing `*`):  `vercel.dns.*` — the literal prefix plus anything deeper
//   - plugin-wide:      `vercel.*`
//   - mid-segment `*`:  `vercel.*.*.dns.create` — each NON-trailing `*` matches
//                       EXACTLY ONE segment (e.g. wildcard the owner/connection
//                       segments to target a tool across every connection).
// A `*` is always a complete segment: mid-pattern it consumes one segment,
// trailing it is a subtree. Partial wildcards (`me*`) and a leading `*` (other
// than the universal `*`) are rejected by `isValidPattern`.
// ---------------------------------------------------------------------------

export const matchPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  const patternSegments = pattern.split(".");
  const toolSegments = toolId.split(".");
  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i]!;
    if (seg === "*") {
      // Trailing `*` is a subtree: the literal prefix already matched, so the
      // address matches at this position and anything deeper (or nothing).
      if (i === patternSegments.length - 1) return toolSegments.length >= i;
      // A non-trailing `*` consumes EXACTLY ONE segment; one must exist here.
      if (i >= toolSegments.length) return false;
      continue;
    }
    if (i >= toolSegments.length || toolSegments[i] !== seg) return false;
  }
  // Pattern exhausted with no trailing `*`: an exact match requires equal length.
  return patternSegments.length === toolSegments.length;
};

export const isValidPattern = (pattern: string): boolean => {
  if (pattern.length === 0) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith(".") || pattern.endsWith(".")) return false;
  if (pattern.includes("..")) return false;
  if (pattern.startsWith("*")) return false;
  const segments = pattern.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.length === 0) return false;
    // A `*` segment must be the WHOLE segment — no partial wildcards (`me*`).
    // A `*` is valid mid-pattern (one segment) or trailing (subtree).
    if (seg.includes("*") && seg !== "*") return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Resolution — each owner contributes its first matching rule by local
// position; the most restrictive matched action across owners wins. Caller
// passes an `ownerRank` so the resolver doesn't need to know which owner is
// the outer guardrail.
// ---------------------------------------------------------------------------

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
  ownerRank: (row: Pick<ToolPolicyRow, "owner">) => number,
): PolicyMatch | undefined => {
  if (policies.length === 0) return undefined;
  const sorted = [...policies].sort((a, b) => {
    const sa = ownerRank(a);
    const sb = ownerRank(b);
    if (sa !== sb) return sa - sb;
    return comparePolicyRow(a, b);
  });
  const firstMatchByOwner = new Map<string, PolicyMatch>();
  for (const row of sorted) {
    if (firstMatchByOwner.has(row.owner)) continue;
    if (matchPattern(row.pattern, toolId)) {
      firstMatchByOwner.set(row.owner, {
        action: row.action as ToolPolicyAction,
        pattern: row.pattern,
        policyId: row.id,
      });
    }
  }
  let selected: PolicyMatch | undefined;
  for (const match of firstMatchByOwner.values()) {
    selected = moreRestrictive(selected, match);
  }
  return selected;
};

// ---------------------------------------------------------------------------
// Layered resolution — user-authored rules + plugin default `requiresApproval`.
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
  ownerRank: (row: Pick<ToolPolicyRow, "owner">) => number,
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  const match = resolveToolPolicy(toolId, policies, ownerRank);
  return match ? liftUser(match) : liftPlugin(defaultRequiresApproval);
};

export const effectivePolicyFromSorted = (
  toolId: string,
  sortedPolicies: readonly (Pick<ToolPolicy, "pattern" | "action" | "id"> &
    Partial<Pick<ToolPolicy, "owner">>)[],
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  const firstMatchByOwner = new Map<string, EffectivePolicy>();
  for (const p of sortedPolicies) {
    const ownerKey = "owner" in p && p.owner ? String(p.owner) : "__flat__";
    if (firstMatchByOwner.has(ownerKey)) continue;
    if (matchPattern(p.pattern, toolId)) {
      firstMatchByOwner.set(ownerKey, {
        action: p.action,
        source: "user",
        pattern: p.pattern,
        policyId: p.id,
      });
    }
  }
  let selected: EffectivePolicy | undefined;
  for (const match of firstMatchByOwner.values()) {
    selected = moreRestrictive(selected, match);
  }
  return selected ?? liftPlugin(defaultRequiresApproval);
};

// ---------------------------------------------------------------------------
// Row → public projection.
// ---------------------------------------------------------------------------

export const rowToToolPolicy = (row: ToolPolicyRow): ToolPolicy => ({
  id: PolicyId.make(row.id),
  owner: row.owner as Owner,
  pattern: row.pattern,
  action: row.action as ToolPolicyAction,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const ToolPolicyActionSchema = Schema.Literals(["approve", "require_approval", "block"]);
