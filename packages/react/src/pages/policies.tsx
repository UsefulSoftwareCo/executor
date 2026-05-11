import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { generateKeyBetween } from "fractional-indexing";
import { ChevronDownIcon } from "lucide-react";
import { PolicyId, ScopeId, type ToolPolicyAction } from "@executor-js/sdk";

import {
  createPolicyOptimistic,
  policiesOptimisticAtom,
  removePolicyOptimistic,
  updatePolicyOptimistic,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";
import { useScope, useScopeStack } from "../hooks/use-scope";
import { badgeVariants } from "../components/badge";
import { cn } from "../lib/utils";
import {
  POLICY_ACTION_LABEL,
  POLICY_ACTIONS_IN_ORDER,
  POLICY_BADGE_VARIANT,
} from "../lib/policy-display";
import { Button } from "../components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Input } from "../components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectPrimitiveTrigger,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { Label } from "../components/label";

// ---------------------------------------------------------------------------
// Sort comparator — fractional-indexing key, then id as a stable tiebreak.
// Identical positions can briefly happen across racing inserts; without the
// tiebreak the rendered order flips between refetches, and `generateKeyBetween`
// would also throw if asked to insert "between" two equal keys.
// ---------------------------------------------------------------------------

const comparePolicy = (posA: string, idA: string, posB: string, idB: string): number => {
  if (posA < posB) return -1;
  if (posA > posB) return 1;
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
};

// ---------------------------------------------------------------------------
// Pattern matcher (mirrors `matchPattern` in @executor-js/sdk) — used for the
// live "this rule matches N tools" preview without a server round-trip.
// Kept inline so the React package doesn't take a runtime dep on the SDK
// for one tiny pure function. If they drift, only the preview is stale.
// ---------------------------------------------------------------------------

const matchesPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  if (pattern === toolId) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    if (prefix.length === 0) return false;
    return toolId === prefix || toolId.startsWith(`${prefix}.`);
  }
  return false;
};

const isValidPattern = (pattern: string): boolean => {
  if (pattern.length === 0) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith(".") || pattern.endsWith(".")) return false;
  if (pattern.includes("..")) return false;
  if (pattern.startsWith("*")) return false;
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
// Add-policy form
// ---------------------------------------------------------------------------

function AddPolicyForm(props: {
  onSubmit: (input: { targetScope: ScopeId; pattern: string; action: ToolPolicyAction }) => void;
  scopeOptions: readonly { readonly id: ScopeId; readonly label: string }[];
  targetScope: ScopeId;
  onTargetScopeChange: (scopeId: ScopeId) => void;
  busy: boolean;
}) {
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<ToolPolicyAction>("require_approval");
  const valid = isValidPattern(pattern);

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        props.onSubmit({ targetScope: props.targetScope, pattern, action });
        setPattern("");
        setAction("require_approval");
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="policy-pattern" className="text-xs font-medium text-foreground/80">
          Pattern
        </Label>
        <Input
          id="policy-pattern"
          placeholder="vercel.dns.* or *"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Exact tool id, trailing wildcard, or <code className="font-mono">*</code> for every tool.
          Examples: <code className="font-mono">*</code>,{" "}
          <code className="font-mono">vercel.*</code>,{" "}
          <code className="font-mono">vercel.dns.*</code>,{" "}
          <code className="font-mono">vercel.dns.create</code>.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs font-medium text-foreground/80">Action</Label>
        <Select value={action} onValueChange={(v) => setAction(v as ToolPolicyAction)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLICY_ACTIONS_IN_ORDER.map((a) => (
              <SelectItem key={a} value={a}>
                {POLICY_ACTION_LABEL[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {props.scopeOptions.length > 1 && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs font-medium text-foreground/80">Target</Label>
          <Select
            value={props.targetScope}
            onValueChange={(value) => props.onTargetScopeChange(ScopeId.make(value))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.scopeOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex items-center justify-end">
        <Button type="submit" disabled={!valid || props.busy} size="sm">
          Add policy
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Policy row
// ---------------------------------------------------------------------------

function PolicyRow(props: {
  policy: {
    id: string;
    scopeId: ScopeId;
    scopeLabel: string;
    pattern: string;
    action: ToolPolicyAction;
  };
  isFirst: boolean;
  isLast: boolean;
  onRemove: () => void;
  onChangeAction: (action: ToolPolicyAction) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex items-center gap-2 font-mono text-sm">
          <span className="truncate">{props.policy.pattern}</span>
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-sans text-[10px] leading-none text-muted-foreground">
            {props.policy.scopeLabel}
          </span>
        </CardStackEntryTitle>
      </CardStackEntryContent>
      <CardStackEntryActions>
        <Select
          value={props.policy.action}
          onValueChange={(v) => props.onChangeAction(v as ToolPolicyAction)}
        >
          <SelectPrimitiveTrigger
            className={cn(
              badgeVariants({
                variant: POLICY_BADGE_VARIANT[props.policy.action],
              }),
              "cursor-pointer pr-1.5 gap-1 transition-[opacity,box-shadow] hover:opacity-80 focus-visible:outline-none data-[state=open]:ring-2 data-[state=open]:ring-ring/50",
            )}
          >
            {POLICY_ACTION_LABEL[props.policy.action]}
            <ChevronDownIcon className="size-3 opacity-70" />
          </SelectPrimitiveTrigger>
          <SelectContent position="popper" align="end">
            {POLICY_ACTIONS_IN_ORDER.map((a) => (
              <SelectItem key={a} value={a}>
                {POLICY_ACTION_LABEL[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="size-3">
                <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="13" r="1.2" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem disabled={props.isFirst} onClick={props.onMoveUp}>
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={props.isLast} onClick={props.onMoveDown}>
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-sm"
              onClick={props.onRemove}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PoliciesPage() {
  const scopeId = useScope();
  const scopeStack = useScopeStack();
  const policies = useAtomValue(policiesOptimisticAtom(scopeId));
  const doCreate = useAtomSet(createPolicyOptimistic(scopeId), {
    mode: "promiseExit",
  });
  const doUpdate = useAtomSet(updatePolicyOptimistic(scopeId), {
    mode: "promise",
  });
  const doRemove = useAtomSet(removePolicyOptimistic(scopeId), {
    mode: "promise",
  });
  const [busy, setBusy] = useState(false);
  const [targetScope, setTargetScope] = useState<ScopeId>(scopeId);

  const scopeOptions =
    scopeStack.length > 0
      ? scopeStack.map((entry, index) => ({
          id: entry.id,
          label: index === 0 ? "Personal" : entry.name,
        }))
      : [{ id: scopeId, label: "Current scope" }];
  const scopeRank = (id: ScopeId): number => {
    const index = scopeOptions.findIndex((option) => option.id === id);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const scopeLabel = (id: ScopeId): string =>
    scopeOptions.find((option) => option.id === id)?.label ?? String(id);

  const handleCreate = async (input: {
    targetScope: ScopeId;
    pattern: string;
    action: ToolPolicyAction;
  }) => {
    setBusy(true);
    const exit = await doCreate({
      params: { scopeId },
      payload: {
        targetScope: input.targetScope,
        pattern: input.pattern,
        action: input.action,
      },
      reactivityKeys: policyWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  const handleUpdate = async (
    policy: { id: string; scopeId: ScopeId },
    action: ToolPolicyAction,
  ) => {
    await doUpdate({
      params: { scopeId, policyId: PolicyId.make(policy.id) },
      payload: { targetScope: policy.scopeId, action },
      reactivityKeys: policyWriteKeys,
    });
  };

  const handleRemove = async (policy: { id: string; scopeId: ScopeId }) => {
    await doRemove({
      params: { scopeId: policy.scopeId, policyId: PolicyId.make(policy.id) },
      reactivityKeys: policyWriteKeys,
    });
  };

  const handleMove = async (policy: { id: string; scopeId: ScopeId }, position: string) => {
    await doUpdate({
      params: { scopeId, policyId: PolicyId.make(policy.id) },
      payload: { targetScope: policy.scopeId, position },
      reactivityKeys: policyWriteKeys,
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
              Policies
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Override default approval behavior for tools. Rules are evaluated top-to-bottom; the
              first match wins. Blocked tools are hidden from agent search and fail at invoke.
            </p>
          </div>
        </div>

        <div className="mb-8">
          <AddPolicyForm
            onSubmit={handleCreate}
            scopeOptions={scopeOptions}
            targetScope={targetScope}
            onTargetScopeChange={setTargetScope}
            busy={busy}
          />
        </div>

        {AsyncResult.match(policies, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
              <p className="text-sm text-muted-foreground">Loading policies…</p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">Failed to load policies</p>
            </div>
          ),
          onSuccess: ({ value }) => {
            // Sort by position (lex order on fractional-indexing keys),
            // tiebreaking on id so identical positions don't swap on refetch
            // and `generateKeyBetween` never sees duplicate neighbor keys
            // (which would throw). Optimistic placeholders carry
            // `position: ""` so they sort to the top.
            const sorted = [...value].sort((a, b) => {
              const scopeOrder = scopeRank(a.scopeId) - scopeRank(b.scopeId);
              return scopeOrder === 0
                ? comparePolicy(a.position, a.id, b.position, b.id)
                : scopeOrder;
            });
            // Reorder math runs against committed rows only — placeholder
            // rows (empty `position`) aren't valid keys for
            // `generateKeyBetween` and aren't reorderable until the server
            // confirms.
            const committedForScope = (ownerScope: ScopeId) =>
              sorted.filter((p) => p.scopeId === ownerScope && p.position !== "");
            const committedIndex = (id: string, ownerScope: ScopeId): number =>
              committedForScope(ownerScope).findIndex((p) => p.id === id);
            const positionAbove = (id: string, ownerScope: ScopeId): string => {
              const committed = committedForScope(ownerScope);
              const j = committedIndex(id, ownerScope);
              if (j <= 0) return generateKeyBetween(null, committed[0]!.position);
              return j === 1
                ? generateKeyBetween(null, committed[0]!.position)
                : generateKeyBetween(committed[j - 2]!.position, committed[j - 1]!.position);
            };
            const positionBelow = (id: string, ownerScope: ScopeId): string => {
              const committed = committedForScope(ownerScope);
              const j = committedIndex(id, ownerScope);
              if (j === -1 || j >= committed.length - 1)
                return generateKeyBetween(committed[committed.length - 1]!.position, null);
              return j === committed.length - 2
                ? generateKeyBetween(committed[committed.length - 1]!.position, null)
                : generateKeyBetween(committed[j + 1]!.position, committed[j + 2]!.position);
            };
            return (
              <CardStack>
                <CardStackHeader>Active policies</CardStackHeader>
                <CardStackContent>
                  {sorted.length === 0 ? (
                    <CardStackEntry>
                      <CardStackEntryContent>
                        <CardStackEntryDescription>
                          No policies yet. Tools fall back to their plugin's default approval
                          behavior.
                        </CardStackEntryDescription>
                      </CardStackEntryContent>
                    </CardStackEntry>
                  ) : (
                    sorted.map((p) => {
                      const committed = committedForScope(p.scopeId);
                      const j = committedIndex(p.id, p.scopeId);
                      // Pending placeholder or only one committed row → no
                      // reorder affordance.
                      const reorderable = j !== -1 && committed.length > 1;
                      return (
                        <PolicyRow
                          key={p.id}
                          policy={{
                            id: p.id,
                            scopeId: p.scopeId,
                            scopeLabel: scopeLabel(p.scopeId),
                            pattern: p.pattern,
                            action: p.action,
                          }}
                          isFirst={!reorderable || j === 0}
                          isLast={!reorderable || j === committed.length - 1}
                          onRemove={() => handleRemove({ id: p.id, scopeId: p.scopeId })}
                          onChangeAction={(action) =>
                            handleUpdate({ id: p.id, scopeId: p.scopeId }, action)
                          }
                          onMoveUp={() =>
                            handleMove(
                              { id: p.id, scopeId: p.scopeId },
                              positionAbove(p.id, p.scopeId),
                            )
                          }
                          onMoveDown={() =>
                            handleMove(
                              { id: p.id, scopeId: p.scopeId },
                              positionBelow(p.id, p.scopeId),
                            )
                          }
                        />
                      );
                    })
                  )}
                </CardStackContent>
              </CardStack>
            );
          },
        })}
      </div>
    </div>
  );
}

// Exported for tests / direct consumers that don't want the matcher
// duplicated in two places. Cloud's UI uses these for live preview.
export { matchesPattern, isValidPattern };
