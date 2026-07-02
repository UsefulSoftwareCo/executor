import { useCallback, useMemo } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { generateKeyBetween } from "fractional-indexing";
import { PolicyId, type Owner, type ToolPolicyAction } from "@executor-js/sdk/shared";

import {
  createPolicyOptimistic,
  policiesOptimisticAtom,
  removePolicyOptimistic,
  updatePolicyOptimistic,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";
import { trackEvent } from "../api/analytics";

// Specificity score for ordering. Higher = more specific = should sit at a
// lower position-key (higher precedence). New rules are auto-placed below
// any more-specific existing rules so a freshly-added group rule never
// silently shadows an existing leaf rule.
//   `*`            → 0
//   `vercel.*`     → 2  (1 literal segment, wildcard)
//   `vercel.dns.*` → 4  (2 literal segments, wildcard)
//   `vercel.dns`   → 5  (2 literal segments, exact — beats same-prefix wildcard)
//   `vercel.dns.create` → 7  (3 literal segments, exact)
const specificity = (pattern: string): number => {
  if (pattern === "*") return 0;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return prefix.split(".").length * 2;
  }
  return pattern.split(".").length * 2 + 1;
};

export interface PolicyAction {
  /** Set the action on a pattern. If a user rule with this exact pattern
   *  already exists, update it. Otherwise create with auto-placed
   *  position so more-specific rules keep precedence. */
  readonly set: (pattern: string, action: ToolPolicyAction) => Promise<void>;
  /** Remove the user rule with this exact pattern, if any. No-op if none. */
  readonly clear: (pattern: string) => Promise<void>;
  /** True while a write is in flight. */
  readonly busy: boolean;
}

/**
 * Policy write actions, scoped to an explicit `owner` (Personal vs Workspace).
 *
 * The global owner toggle is retired, so this hook no longer reads an ambient
 * owner. Owner is a REAL partition for policy writes (`byOwner(input.owner)` on
 * the server), so the caller chooses it explicitly. It defaults to `"org"`
 * (Workspace) — the same value the old `DEFAULT_OWNER` produced — so existing
 * policy behavior is preserved exactly. The hook filters exact-match candidates
 * to this owner and writes create/update/remove against it.
 */
export const usePolicyActions = (owner: Owner = "org"): PolicyAction => {
  const policies = useAtomValue(policiesOptimisticAtom);
  const doCreate = useAtomSet(createPolicyOptimistic, { mode: "promise" });
  const doUpdate = useAtomSet(updatePolicyOptimistic, { mode: "promise" });
  const doRemove = useAtomSet(removePolicyOptimistic, { mode: "promise" });

  // Sorted by position ASC (lowest position = highest precedence first),
  // matching server evaluation order. Optimistic placeholder rows carry
  // `position: ""` and sort to the very top — that's fine for lookup but
  // they're skipped when computing insert position. Only this owner's rows are
  // candidates for matching an exact pattern we'd update.
  const sorted = useMemo(() => {
    if (!AsyncResult.isSuccess(policies))
      return [] as ReadonlyArray<{
        readonly id: string;
        readonly owner: Owner;
        readonly pattern: string;
        readonly action: ToolPolicyAction;
        readonly position: string;
      }>;
    return [...policies.value]
      .filter((p) => p.owner === owner)
      .sort((a, b) => {
        if (a.position < b.position) return -1;
        if (a.position > b.position) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [policies, owner]);

  const busy = policies.waiting;

  const computePosition = useCallback(
    (newPattern: string): string | undefined => {
      const committed = sorted.filter((r) => r.position !== "");
      if (committed.length === 0) return undefined;
      const newScore = specificity(newPattern);
      // Walk down the list (most-precedent first); place the new rule
      // just before the first existing rule whose specificity is <= the
      // new one. That way more-specific rules stay above us, and we win
      // against everything equally or less specific.
      let idx = committed.findIndex((r) => specificity(r.pattern) <= newScore);
      if (idx === -1) idx = committed.length; // append at bottom
      const prev = idx === 0 ? null : committed[idx - 1]!.position;
      const next = idx === committed.length ? null : committed[idx]!.position;
      return generateKeyBetween(prev, next);
    },
    [sorted],
  );

  const findExact = useCallback(
    (pattern: string) => sorted.find((r) => r.pattern === pattern && r.position !== ""),
    [sorted],
  );

  const set = useCallback(
    async (pattern: string, action: ToolPolicyAction) => {
      const patternKind = pattern.endsWith(".*") ? "group" : "exact";
      const existing = findExact(pattern);
      if (existing) {
        if (existing.action === action) return;
        await doUpdate({
          params: { policyId: PolicyId.make(existing.id) },
          payload: { owner, action },
          reactivityKeys: policyWriteKeys,
        });
        trackEvent("tool_policy_set", { action, pattern_kind: patternKind, owner });
        return;
      }
      const position = computePosition(pattern);
      await doCreate({
        payload:
          position === undefined
            ? { owner, pattern, action }
            : { owner, pattern, action, position },
        reactivityKeys: policyWriteKeys,
      });
      trackEvent("tool_policy_set", { action, pattern_kind: patternKind, owner });
    },
    [owner, doCreate, doUpdate, findExact, computePosition],
  );

  const clear = useCallback(
    async (pattern: string) => {
      const existing = findExact(pattern);
      if (!existing) return;
      await doRemove({
        params: { policyId: PolicyId.make(existing.id) },
        payload: { owner },
        reactivityKeys: policyWriteKeys,
      });
      trackEvent("tool_policy_cleared", {
        pattern_kind: pattern.endsWith(".*") ? "group" : "exact",
        owner,
      });
    },
    [owner, doRemove, findExact],
  );

  return { set, clear, busy };
};
