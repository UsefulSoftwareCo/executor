import { useCallback, useMemo, useRef } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { toast } from "sonner";
import {
  PolicyId,
  positionForNewPattern,
  type Owner,
  type ToolPolicyAction,
} from "@executor-js/sdk/shared";

import {
  createPolicyOptimistic,
  policiesOptimisticAtom,
  removePolicyOptimistic,
  updatePolicyOptimistic,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";
import { trackEvent } from "../api/analytics";
import { messageFromExit } from "../api/error-reporting";

export interface PolicyAction {
  /** Set the action on a pattern. If a user rule with this exact pattern
   *  already exists, update it. Otherwise create with auto-placed
   *  position so more-specific rules keep precedence. */
  readonly set: (pattern: string, action: ToolPolicyAction) => Promise<void>;
  /** Remove the user rule with this exact pattern, if any. `policyId` is the
   *  id of the rule the caller believes is active (e.g. from the tool's
   *  resolved EffectivePolicy); it is the fallback when the local policies
   *  list is mid-refresh and doesn't contain the rule yet — without it a
   *  clear in that window silently no-ops. */
  readonly clear: (pattern: string, policyId?: string) => Promise<void>;
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
  const doCreate = useAtomSet(createPolicyOptimistic, { mode: "promiseExit" });
  const doUpdate = useAtomSet(updatePolicyOptimistic, { mode: "promiseExit" });
  const doRemove = useAtomSet(removePolicyOptimistic, { mode: "promiseExit" });

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

  // Server-assigned ids of rules this hook created, by pattern. The local
  // policies list is optimistic: right after a create it holds a placeholder
  // row with a fake `pending-*` id (and the resolved EffectivePolicy a caller
  // hands back can carry that same fake id), so neither is safe to DELETE
  // with. The create response is the one authoritative id source in that
  // window.
  const createdIdByPattern = useRef(new Map<string, string>());

  // Specificity-aware placement (below any more-specific rule) via the shared
  // sdk helper — the same computation the server applies when no position is
  // sent. Computing it here too keeps the optimistic UI's final order stable;
  // if this client's list is stale, the server default is the backstop.
  const computePosition = useCallback(
    (newPattern: string): string | undefined => {
      const committed = sorted.filter((r) => r.position !== "");
      if (committed.length === 0) return undefined;
      return positionForNewPattern(newPattern, committed);
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
        const exit = await doUpdate({
          params: { policyId: PolicyId.make(existing.id) },
          payload: { owner, action },
          reactivityKeys: policyWriteKeys,
        });
        if (Exit.isFailure(exit)) {
          toast.error(messageFromExit(exit, "Failed to update policy"));
          return;
        }
        trackEvent("tool_policy_set", { action, pattern_kind: patternKind, owner });
        return;
      }
      const position = computePosition(pattern);
      const exit = await doCreate({
        payload:
          position === undefined
            ? { owner, pattern, action }
            : { owner, pattern, action, position },
        reactivityKeys: policyWriteKeys,
      });
      if (Exit.isFailure(exit)) {
        toast.error(messageFromExit(exit, "Failed to create policy"));
        return;
      }
      createdIdByPattern.current.set(pattern, String(exit.value.id));
      trackEvent("tool_policy_set", { action, pattern_kind: patternKind, owner });
    },
    [owner, doCreate, doUpdate, findExact, computePosition],
  );

  const clear = useCallback(
    async (pattern: string, policyId?: string) => {
      // Resolve the id to delete, most-authoritative first. The local list
      // and the caller's resolved policy can both hold an optimistic
      // `pending-*` placeholder id right after a create (before the
      // post-commit refetch lands); the create response we recorded is real,
      // and a placeholder id must never reach the server.
      const existing = findExact(pattern);
      const isReal = (id: string | undefined): id is string => !!id && !id.startsWith("pending-");
      const id = [existing?.id, createdIdByPattern.current.get(pattern), policyId].find(isReal);
      if (!id) return;
      const exit = await doRemove({
        params: { policyId: PolicyId.make(id) },
        payload: { owner },
        reactivityKeys: policyWriteKeys,
      });
      if (Exit.isFailure(exit)) {
        toast.error(messageFromExit(exit, "Failed to clear policy"));
        return;
      }
      createdIdByPattern.current.delete(pattern);
      trackEvent("tool_policy_cleared", {
        pattern_kind: pattern.endsWith(".*") ? "group" : "exact",
        owner,
      });
    },
    [owner, doRemove, findExact],
  );

  return { set, clear, busy };
};
