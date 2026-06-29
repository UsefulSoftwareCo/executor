import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { trackEvent } from "../api/analytics";
import { generateKeyBetween } from "fractional-indexing";
import { ChevronDownIcon } from "lucide-react";
import {
  PolicyId,
  matchPattern,
  isValidPattern,
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
import { ownerLabel, useOwnerDisplay } from "../api/owner-display";
import { badgeVariants } from "../components/badge";
import { cn } from "../lib/utils";
import {
  POLICY_ACTION_LABEL,
  POLICY_ACTIONS_IN_ORDER,
  POLICY_BADGE_VARIANT,
} from "../lib/policy-display";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
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

// Owner guardrail ordering: org rules are the outer guardrail (rank 0), user
// rules are inner (rank 1). Mirrors server-side resolution where the most
// restrictive matched action across owners wins.
const ownerRank = (owner: Owner): number => (owner === "org" ? 0 : 1);

// The two owners a policy can target.
const POLICY_OWNERS: readonly { readonly owner: Owner; readonly label: string }[] = [
  { owner: "org", label: "Workspace" },
  { owner: "user", label: "Personal" },
];

// ---------------------------------------------------------------------------
// Sort comparator — owner rank, then fractional-indexing key, then id as a
// stable tiebreak. Identical positions can briefly happen across racing
// inserts; without the tiebreak the rendered order flips between refetches, and
// `generateKeyBetween` would also throw if asked to insert "between" two equal
// keys.
// ---------------------------------------------------------------------------

const comparePolicy = (posA: string, idA: string, posB: string, idB: string): number => {
  if (posA < posB) return -1;
  if (posA > posB) return 1;
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
};

// Pattern matching + validation come from the SDK so the UI's "matches N tools"
// preview and the add-policy validation use the EXACT same grammar the executor
// enforces — including mid-segment wildcards (`integration.*.*.tool`), which the
// connection-aware policy model now relies on. (Re-exported below for callers.)
const matchesPattern = matchPattern;

// ---------------------------------------------------------------------------
// Add-policy form
// ---------------------------------------------------------------------------

function AddPolicyForm(props: {
  onSubmit: (input: { owner: Owner; pattern: string; action: ToolPolicyAction }) => void;
  owner: Owner;
  onOwnerChange: (owner: Owner) => void;
  busy: boolean;
}) {
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<ToolPolicyAction>("require_approval");
  const valid = isValidPattern(pattern);
  // Non-org hosts (local/desktop) have one local workspace. New local policies
  // are org-owned internally to match the v1->v2 migration.
  const ownerDisplay = useOwnerDisplay();
  const ownerChoices = ownerDisplay.isSinglePlayerHost
    ? POLICY_OWNERS.filter((option) => option.owner === "org").map((option) => ({
        ...option,
        label: "Local",
      }))
    : POLICY_OWNERS;

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        props.onSubmit({ owner: props.owner, pattern, action });
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
      {ownerChoices.length > 1 ? (
        <div className="flex flex-col gap-1">
          <Label className="text-xs font-medium text-foreground/80">Applies to</Label>
          <Select
            value={props.owner}
            onValueChange={(value) => props.onOwnerChange(value as Owner)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ownerChoices.map((option) => (
                <SelectItem key={option.owner} value={option.owner}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
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
    owner: Owner;
    pattern: string;
    action: ToolPolicyAction;
  };
  isFirst: boolean;
  isLast: boolean;
  onRemove: () => void;
  onChangeAction: (action: ToolPolicyAction) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  showOwnerLabel: boolean;
}) {
  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex items-center gap-2 font-mono text-sm">
          <span className="truncate">{props.policy.pattern}</span>
          {props.showOwnerLabel ? (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-sans text-[10px] leading-none text-muted-foreground">
              {ownerLabel(props.policy.owner)}
            </span>
          ) : null}
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
  const policies = useAtomValue(policiesOptimisticAtom);
  const doCreate = useAtomSet(createPolicyOptimistic, { mode: "promiseExit" });
  const doUpdate = useAtomSet(updatePolicyOptimistic, { mode: "promiseExit" });
  const doRemove = useAtomSet(removePolicyOptimistic, { mode: "promiseExit" });
  const [busy, setBusy] = useState(false);
  const ownerDisplay = useOwnerDisplay();
  // Policies default to org/workspace. On local this is the hidden Local owner
  // that v1 local data migrates into.
  const [targetOwner, setTargetOwner] = useState<Owner>("org");

  const handleCreate = async (input: {
    owner: Owner;
    pattern: string;
    action: ToolPolicyAction;
  }) => {
    setBusy(true);
    const exit = await doCreate({
      payload: {
        owner: input.owner,
        pattern: input.pattern,
        action: input.action,
      },
      reactivityKeys: policyWriteKeys,
    });
    trackEvent("policy_created", {
      action: input.action,
      owner: input.owner,
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  const handleUpdate = async (policy: { id: string; owner: Owner }, action: ToolPolicyAction) => {
    const exit = await doUpdate({
      params: { policyId: PolicyId.make(policy.id) },
      payload: { owner: policy.owner, action },
      reactivityKeys: policyWriteKeys,
    });
    trackEvent("policy_action_changed", {
      action,
      owner: policy.owner,
      success: Exit.isSuccess(exit),
    });
  };

  const handleRemove = async (policy: { id: string; owner: Owner }) => {
    const exit = await doRemove({
      params: { policyId: PolicyId.make(policy.id) },
      payload: { owner: policy.owner },
      reactivityKeys: policyWriteKeys,
    });
    trackEvent("policy_removed", { owner: policy.owner, success: Exit.isSuccess(exit) });
  };

  const handleMove = async (
    policy: { id: string; owner: Owner },
    position: string,
    direction: "up" | "down",
  ) => {
    const exit = await doUpdate({
      params: { policyId: PolicyId.make(policy.id) },
      payload: { owner: policy.owner, position },
      reactivityKeys: policyWriteKeys,
    });
    trackEvent("policy_reordered", {
      owner: policy.owner,
      direction,
      success: Exit.isSuccess(exit),
    });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Policies"
        description="Override default approval behavior for tools. The most restrictive matched action wins. Blocked tools are hidden from agent search and fail at invoke."
      />

      <div className="mb-8">
        <AddPolicyForm
          onSubmit={handleCreate}
          owner={targetOwner}
          onOwnerChange={setTargetOwner}
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
          // Sort by owner rank (org outer, user inner), then position (lex
          // order on fractional-indexing keys), tiebreaking on id so
          // identical positions don't swap on refetch and
          // `generateKeyBetween` never sees duplicate neighbor keys (which
          // would throw). Optimistic placeholders carry `position: ""` so
          // they sort to the top of their owner group.
          const sorted = [...value].sort((a, b) => {
            const ownerOrder = ownerRank(a.owner) - ownerRank(b.owner);
            return ownerOrder === 0
              ? comparePolicy(a.position, a.id, b.position, b.id)
              : ownerOrder;
          });
          // Reorder math runs against committed rows only — placeholder rows
          // (empty `position`) aren't valid keys for `generateKeyBetween` and
          // aren't reorderable until the server confirms.
          const committedForOwner = (owner: Owner) =>
            sorted.filter((p) => p.owner === owner && p.position !== "");
          const committedIndex = (id: string, owner: Owner): number =>
            committedForOwner(owner).findIndex((p) => p.id === id);
          const positionAbove = (id: string, owner: Owner): string => {
            const committed = committedForOwner(owner);
            const j = committedIndex(id, owner);
            if (j <= 0) return generateKeyBetween(null, committed[0]!.position);
            return j === 1
              ? generateKeyBetween(null, committed[0]!.position)
              : generateKeyBetween(committed[j - 2]!.position, committed[j - 1]!.position);
          };
          const positionBelow = (id: string, owner: Owner): string => {
            const committed = committedForOwner(owner);
            const j = committedIndex(id, owner);
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
                    const committed = committedForOwner(p.owner);
                    const j = committedIndex(p.id, p.owner);
                    // Pending placeholder or only one committed row → no
                    // reorder affordance.
                    const reorderable = j !== -1 && committed.length > 1;
                    return (
                      <PolicyRow
                        key={p.id}
                        policy={{
                          id: p.id,
                          owner: p.owner,
                          pattern: p.pattern,
                          action: p.action,
                        }}
                        isFirst={!reorderable || j === 0}
                        isLast={!reorderable || j === committed.length - 1}
                        showOwnerLabel={ownerDisplay.showOwnerLabels}
                        onRemove={() => handleRemove({ id: p.id, owner: p.owner })}
                        onChangeAction={(action) =>
                          handleUpdate({ id: p.id, owner: p.owner }, action)
                        }
                        onMoveUp={() =>
                          handleMove(
                            { id: p.id, owner: p.owner },
                            positionAbove(p.id, p.owner),
                            "up",
                          )
                        }
                        onMoveDown={() =>
                          handleMove(
                            { id: p.id, owner: p.owner },
                            positionBelow(p.id, p.owner),
                            "down",
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
    </PageContainer>
  );
}

// Exported for tests / direct consumers that don't want the matcher
// duplicated in two places. Cloud's UI uses these for live preview.
export { matchesPattern, isValidPattern };
