// ---------------------------------------------------------------------------
// Tool policies — the decision VOCABULARY (types, schemas, projections) plus
// the pure pattern-matching and rule-placement utilities the executor's CRUD
// surface needs. Policies are owner-scoped (org | user) rows.
//
// HOW rules resolve into an effective decision — owner ranking, the
// most-restrictive merge across owners, the plugin-default fallback and the
// capability-allowlist default — is a PRODUCT rule: it lives in
// `@executor-js/product-access/policy` and reaches core only through the
// `ExecutorAccess.toolPolicy` hook, whose `EffectivePolicy` answers core
// enforces at list/schema/invoke/approval-recheck.
// ---------------------------------------------------------------------------

import { Schema } from "effect";
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
// Ordering / placement utilities. HOW matched rules combine into an
// effective decision (owner ranking, most-restrictive merge, fallbacks) is a
// PRODUCT rule and lives in `@executor-js/product-access/policy`; core only
// consumes the resulting `EffectivePolicy` through
// `ExecutorAccess.toolPolicy` and enforces it.
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
//   `*`            → 0
//   `vercel.*`     → 2  (1 literal segment, wildcard)
//   `vercel.dns.*` → 4  (2 literal segments, wildcard)
//   `vercel.dns`   → 5  (2 literal segments, exact — beats same-prefix wildcard)
//   `vercel.dns.create` → 7  (3 literal segments, exact)
export const patternSpecificity = (pattern: string): number => {
  if (pattern === "*") return 0;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return prefix.split(".").length * 2;
  }
  return pattern.split(".").length * 2 + 1;
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
