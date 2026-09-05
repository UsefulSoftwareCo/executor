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
import { generateKeyBetween } from "fractional-indexing";

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
//   - name prefix:      `vercel.*.*.dns.get*` — a trailing `*` inside a segment
//                       matches the rest of that ONE tool-name segment
//   - globstar:         `vercel.*.*.**.get*` — `**` matches zero or more
//                       structured tool-name segments
// A complete trailing `*` keeps its legacy subtree meaning. Leading wildcards
// (other than the universal `*`) and non-trailing partial wildcards (`g*t`) are
// rejected by `isValidPattern`.
// ---------------------------------------------------------------------------

export const matchPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  const patternSegments = pattern.split(".");
  const toolSegments = toolId.split(".");

  // Keep the common path allocation-light: existing exact / segment-wildcard
  // rules and new name-prefix rules do not need globstar backtracking.
  if (!patternSegments.includes("**")) {
    for (let i = 0; i < patternSegments.length; i++) {
      const segment = patternSegments[i]!;
      if (segment === "*") {
        if (i === patternSegments.length - 1) return toolSegments.length >= i;
        if (i >= toolSegments.length) return false;
        continue;
      }
      if (i >= toolSegments.length) return false;
      if (segment.endsWith("*")) {
        if (!toolSegments[i]!.startsWith(segment.slice(0, -1))) return false;
      } else if (toolSegments[i] !== segment) {
        return false;
      }
    }
    return patternSegments.length === toolSegments.length;
  }

  const memo = new Map<string, boolean>();

  const matchesFrom = (patternIndex: number, toolIndex: number): boolean => {
    const memoKey = `${patternIndex}:${toolIndex}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;

    if (patternIndex === patternSegments.length) {
      const result = toolIndex === toolSegments.length;
      memo.set(memoKey, result);
      return result;
    }

    const segment = patternSegments[patternIndex]!;
    let result: boolean;
    if (segment === "**") {
      // Globstar may consume no segment, or consume one and remain active.
      result =
        matchesFrom(patternIndex + 1, toolIndex) ||
        (toolIndex < toolSegments.length && matchesFrom(patternIndex, toolIndex + 1));
    } else if (segment === "*") {
      // Preserve the original grammar: a complete trailing `*` is a subtree,
      // while a complete mid-pattern `*` consumes exactly one segment.
      result =
        patternIndex === patternSegments.length - 1
          ? toolSegments.length >= toolIndex
          : toolIndex < toolSegments.length && matchesFrom(patternIndex + 1, toolIndex + 1);
    } else if (segment.endsWith("*")) {
      const prefix = segment.slice(0, -1);
      result =
        toolIndex < toolSegments.length &&
        toolSegments[toolIndex]!.startsWith(prefix) &&
        matchesFrom(patternIndex + 1, toolIndex + 1);
    } else {
      result =
        toolIndex < toolSegments.length &&
        toolSegments[toolIndex] === segment &&
        matchesFrom(patternIndex + 1, toolIndex + 1);
    }

    memo.set(memoKey, result);
    return result;
  };

  return matchesFrom(0, 0);
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
    if (!seg.includes("*")) continue;
    // Complete wildcard segments retain their existing meaning; `**` adds an
    // explicit zero-or-more form that can be followed by a tool-name prefix.
    if (seg === "*" || seg === "**") continue;
    // Partial wildcards apply only to the final tool-name segment and only as
    // a suffix (`get*`, never an owner/connection wildcard, `g*t`, or `*get`).
    if (i === 0 || i !== segments.length - 1 || !seg.endsWith("*")) return false;
    const prefix = seg.slice(0, -1);
    if (prefix.length === 0 || prefix.includes("*")) return false;
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

// Specificity score for ordering. Higher = more specific = should sit at a
// lower position-key (higher precedence). New rules are auto-placed below
// any more-specific existing rules so a freshly-added group rule never
// silently shadows an existing leaf rule.
// Literal segments contribute 2, name-prefix segments contribute 1, complete
// wildcards contribute 0, and a pattern with no wildcard receives an exact
// bonus. This preserves the original examples while placing a rule such as
// `vercel.*.*.**.get*` below an exact tool and above `vercel.*`.
//   `*`                    → 0
//   `vercel.*`             → 2
//   `vercel.dns.*`         → 4
//   `vercel.dns`           → 5
//   `vercel.*.*.**.get*`   → 3
//   `vercel.dns.create`    → 7
export const patternSpecificity = (pattern: string): number => {
  if (pattern === "*") return 0;
  let score = 0;
  let hasWildcard = false;
  for (const segment of pattern.split(".")) {
    if (segment === "*" || segment === "**") {
      hasWildcard = true;
    } else if (segment.endsWith("*")) {
      score += 1;
      hasWildcard = true;
    } else {
      score += 2;
    }
  }
  return score + (hasWildcard ? 0 : 1);
};

/**
 * Position key for a new rule among an owner's existing rules, placed just
 * below every existing rule that is MORE specific (and above everything
 * equally or less specific). Rows must be the owner's committed rules; order
 * doesn't matter, they're sorted here. This is the authoritative default —
 * the server applies it when `create` gets no explicit position, so a rule
 * written by any client (UI, API, agent tool) cannot shadow a more-specific
 * existing rule by racing to the top of the list.
 */
export const positionForNewPattern = (
  pattern: string,
  rows: ReadonlyArray<Pick<ToolPolicyRow, "pattern" | "position" | "id">>,
): string => {
  const committed = [...rows].sort(comparePolicyRow);
  const newScore = patternSpecificity(pattern);
  let idx = committed.findIndex((r) => patternSpecificity(r.pattern) <= newScore);
  if (idx === -1) idx = committed.length; // below every more-specific rule
  const prev = idx === 0 ? null : committed[idx - 1]!.position;
  const next = idx === committed.length ? null : committed[idx]!.position;
  return generateKeyBetween(prev, next);
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
