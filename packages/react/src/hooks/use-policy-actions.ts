import { useCallback, useMemo } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { generateKeyBetween } from "fractional-indexing";
import { PolicyId, type ScopeId, type ToolPolicyAction } from "@executor-js/sdk";

import {
  createPolicyOptimistic,
  policiesOptimisticAtom,
  removePolicyOptimistic,
  updatePolicyOptimistic,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";

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

export const usePolicyActions = (scopeId: ScopeId): PolicyAction => {
  const policies = useAtomValue(policiesOptimisticAtom(scopeId));
  const doCreate = useAtomSet(createPolicyOptimistic(scopeId), { mode: "promise" });
  const doUpdate = useAtomSet(updatePolicyOptimistic(scopeId), { mode: "promise" });
  const doRemove = useAtomSet(removePolicyOptimistic(scopeId), { mode: "promise" });

  // Sorted by position ASC (lowest position = highest precedence first),
  // matching server evaluation order. Optimistic placeholder rows carry
  // `position: ""` and sort to the very top — that's fine for lookup but
  // they're skipped when computing insert position.
  const sorted = useMemo(() => {
    if (!AsyncResult.isSuccess(policies))
      return [] as ReadonlyArray<{
        readonly id: string;
        readonly pattern: string;
        readonly action: ToolPolicyAction;
        readonly position: string;
        readonly scopeId: ScopeId;
      }>;
    return [...policies.value].sort((a, b) => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [policies]);

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
      const existing = findExact(pattern);
      if (existing) {
        if (existing.action === action) return;
        await doUpdate({
          params: { scopeId, policyId: PolicyId.make(existing.id) },
          payload: { targetScope: existing.scopeId, action },
          reactivityKeys: policyWriteKeys,
        });
        return;
      }
      const position = computePosition(pattern);
      await doCreate({
        params: { scopeId },
        payload:
          position === undefined
            ? { targetScope: scopeId, pattern, action }
            : { targetScope: scopeId, pattern, action, position },
        reactivityKeys: policyWriteKeys,
      });
    },
    [scopeId, doCreate, doUpdate, findExact, computePosition],
  );

  const clear = useCallback(
    async (pattern: string) => {
      const existing = findExact(pattern);
      if (!existing) return;
      await doRemove({
        params: { scopeId: existing.scopeId, policyId: PolicyId.make(existing.id) },
        reactivityKeys: policyWriteKeys,
      });
    },
    [doRemove, findExact],
  );

  return { set, clear, busy };
};
