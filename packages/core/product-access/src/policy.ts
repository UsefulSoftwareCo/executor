// ---------------------------------------------------------------------------
// The PRODUCT's tool-policy resolution rules — how authored rows and toolkit
// capability rules combine into one `EffectivePolicy`:
//
//   - owner-ranked, per-owner first-match by local position;
//   - the MOST RESTRICTIVE matched action across owners wins, so a user
//     preference cannot weaken an org guardrail (org = outer, user = inner);
//   - no authored match falls back to the tool's own `requiresApproval`
//     annotation (the plugin default);
//   - a list-only toolkit provider is a capability ALLOWLIST: no matching
//     rule means the tool is outside the capability boundary and blocks.
//
// Core (`@executor-js/sdk`) never applies these rules itself: it hands the
// rule material to `ExecutorAccess.toolPolicy` and enforces whatever
// `EffectivePolicy` comes back. This module deliberately imports only the
// browser-safe `@executor-js/sdk/shared` utilities (pattern matching, row
// ordering) at runtime, so UI surfaces can preview the same resolution
// without pulling the server SDK.
// ---------------------------------------------------------------------------

import { Effect, Match } from "effect";

import {
  comparePolicyRow,
  matchPattern,
  type EffectivePolicy,
  type PolicyMatch,
  type ToolPolicy,
} from "@executor-js/sdk/shared";
import type {
  StorageFailure,
  ToolPolicyEvaluationInput,
  ToolPolicyEvaluator,
  ToolPolicyProvider,
  ToolPolicyProviderRule,
  ToolPolicySources,
} from "@executor-js/sdk/core";

/** The stored-row shape resolution reads — structural, so both core's
 *  persisted `ToolPolicyRow` and UI projections satisfy it. */
export interface ToolPolicyRuleLike {
  readonly id: string;
  readonly owner: string;
  readonly pattern: string;
  /** Persisted rows carry a plain string; resolution narrows it. */
  readonly action: string;
  readonly position: string;
}

const actionRestrictionRank = (action: ToolPolicy["action"]): number =>
  Match.value(action).pipe(
    Match.when("block", () => 3),
    Match.when("require_approval", () => 2),
    Match.when("approve", () => 1),
    Match.exhaustive,
  );

const moreRestrictive = <T extends { readonly action: ToolPolicy["action"] }>(
  current: T | undefined,
  candidate: T,
): T => {
  if (!current) return candidate;
  return actionRestrictionRank(candidate.action) > actionRestrictionRank(current.action)
    ? candidate
    : current;
};

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

/**
 * Resolve the matching authored rule for one tool id: each owner contributes
 * its first matching rule by local position, then the most restrictive
 * matched action across owners wins. `ownerRank` orders owners for the
 * per-owner scan (the product's precedence); it never weakens the merge.
 * Returns undefined when no rule matches.
 */
export const resolveToolPolicy = (
  toolId: string,
  policies: readonly ToolPolicyRuleLike[],
  ownerRank: (row: { readonly owner: string }) => number,
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
        action: row.action as ToolPolicy["action"],
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

/**
 * {@link resolveToolPolicy} lifted to an {@link EffectivePolicy}: an authored
 * match wins, else the plugin default (`requiresApproval` →
 * `require_approval`, otherwise `approve`).
 */
export const resolveEffectivePolicy = (
  toolId: string,
  policies: readonly ToolPolicyRuleLike[],
  ownerRank: (row: { readonly owner: string }) => number,
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  const match = resolveToolPolicy(toolId, policies, ownerRank);
  return match ? liftUser(match) : liftPlugin(defaultRequiresApproval);
};

/**
 * UI-preview variant over an ALREADY-SORTED rule list (a settings page's
 * loaded policy list): same per-owner first-match + most-restrictive merge,
 * treating rows without an owner as one flat list.
 */
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

const compareProviderPolicyRule = (
  a: ToolPolicyProviderRule,
  b: ToolPolicyProviderRule,
): number => {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Resolution for a list-only toolkit provider: first matching rule by
 * position wins; NO matching rule blocks — the provider is a capability
 * allowlist, and a tool it does not name is outside the boundary.
 */
export const resolveProviderPolicyFromRules = (
  toolId: string,
  rules: readonly ToolPolicyProviderRule[],
): EffectivePolicy => {
  for (const rule of [...rules].sort(compareProviderPolicyRule)) {
    if (!matchPattern(rule.pattern, toolId)) continue;
    return {
      action: rule.action,
      source: "user",
      pattern: rule.pattern,
      policyId: rule.id,
    };
  }
  return {
    action: "block",
    source: "user",
    pattern: "*",
  };
};

/**
 * The standard product implementation of `ExecutorAccess.toolPolicy`.
 *
 * With a plugin-registered provider (a toolkit session), the provider's own
 * batched `prepare` / per-tool `resolve` / plain `list` allowlist governs.
 * Otherwise the stored owner-scoped rows resolve under the binding's owner
 * precedence with the most-restrictive merge and plugin-default fallback.
 */
export const standardToolPolicy =
  (owners: readonly string[]) =>
  (sources: ToolPolicySources): Effect.Effect<ToolPolicyEvaluator, StorageFailure> => {
    const provider: ToolPolicyProvider | null = sources.provider;
    if (provider) {
      if (provider.prepare) {
        // Batched per-operation resolver: fetch all policy + connection
        // state once, resolve every tool in the operation from the snapshot.
        return provider.prepare().pipe(
          Effect.map(
            (resolve): ToolPolicyEvaluator => ({
              resolve: (input: ToolPolicyEvaluationInput) =>
                Effect.succeed(
                  resolve({
                    toolId: input.toolId,
                    ...(input.defaultRequiresApproval === undefined
                      ? {}
                      : { defaultRequiresApproval: input.defaultRequiresApproval }),
                  }),
                ),
            }),
          ),
        );
      }
      const perTool = provider.resolve;
      if (perTool) {
        return Effect.succeed({
          resolve: (input: ToolPolicyEvaluationInput) =>
            perTool({
              toolId: input.toolId,
              ...(input.defaultRequiresApproval === undefined
                ? {}
                : { defaultRequiresApproval: input.defaultRequiresApproval }),
            }),
        });
      }
      return provider.list().pipe(
        Effect.map(
          (rules): ToolPolicyEvaluator => ({
            resolve: (input) => Effect.succeed(resolveProviderPolicyFromRules(input.toolId, rules)),
          }),
        ),
      );
    }
    const ownerRank = (row: { readonly owner: string }): number => {
      const rank = owners.indexOf(row.owner);
      return rank === -1 ? owners.length : rank;
    };
    return sources.policyRows.pipe(
      Effect.map(
        (rows): ToolPolicyEvaluator => ({
          resolve: (input) =>
            Effect.succeed(
              resolveEffectivePolicy(input.toolId, rows, ownerRank, input.defaultRequiresApproval),
            ),
        }),
      ),
    );
  };
