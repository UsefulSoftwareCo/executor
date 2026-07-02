import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { ToolAddress, effectivePolicyFromSorted } from "@executor-js/sdk/shared";

import { policiesOptimisticAtom, toolsAllAtom } from "../api/atoms";
import { usePolicyActions } from "../hooks/use-policy-actions";
import { ToolTree, type ToolSummary } from "../components/tool-tree";
import { ToolDetail, ToolDetailEmpty } from "../components/tool-detail";
import { Button } from "../components/button";
import { Skeleton } from "../components/skeleton";

// Dynamic tool policy patterns are derived from the connection-aware address.
// Static tools (for example Executor's own tools) use their address directly.
type ToolRow = {
  readonly address: ToolAddress;
  readonly integration: string;
  readonly name: string;
  readonly description: string;
  readonly requiresApproval?: boolean;
  readonly static?: boolean;
};

const policyId = (tool: ToolRow): string =>
  tool.static ? String(tool.address) : `${tool.integration}.${tool.name}`;

export function ToolsPage() {
  // Merged across BOTH owners (omit-owner read). The page dedupes to one row per
  // `<integration>.<tool>` policy id, so owner is irrelevant here — the global
  // Tools page is a flat policy tree, not an account-grouped view. Policy writes
  // still target a specific owner (Workspace default; see usePolicyActions).
  const tools = useAtomValue(toolsAllAtom);
  const policies = useAtomValue(policiesOptimisticAtom);
  const policyActions = usePolicyActions("org");

  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);

  const policyList = useMemo(
    () => (AsyncResult.isSuccess(policies) ? policies.value : []),
    [policies],
  );

  const sortedPolicies = useMemo(
    () =>
      [...policyList].sort((a, b) => {
        if (a.position < b.position) return -1;
        if (a.position > b.position) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
    [policyList],
  );

  // Address + static flag per selection id, so the detail view can fetch the
  // right schema for the selected `<integration>.<tool>` id and its policy
  // badge can write the matching pattern form.
  const selectionById = useMemo(() => {
    const map = new Map<string, { readonly address: ToolAddress; readonly static: boolean }>();
    if (!AsyncResult.isSuccess(tools)) return map;
    for (const t of tools.value as readonly ToolRow[]) {
      const id = policyId(t);
      if (!map.has(id)) map.set(id, { address: t.address, static: t.static === true });
    }
    return map;
  }, [tools]);

  const summaries: ToolSummary[] = useMemo(() => {
    if (!AsyncResult.isSuccess(tools)) return [];
    const seen = new Set<string>();
    const rows: ToolSummary[] = [];
    for (const t of tools.value as readonly ToolRow[]) {
      const id = policyId(t);
      if (seen.has(id)) continue;
      seen.add(id);
      // `id` is the connection-agnostic display id; match policies against the
      // FULL address (`integration.owner.connection.tool`, the address minus its
      // `tools.` prefix) so connection-aware rules resolve.
      const matchId = String(t.address).replace(/^tools\./, "");
      rows.push({
        id,
        name: id,
        description: t.description,
        policy: effectivePolicyFromSorted(matchId, sortedPolicies, t.requiresApproval),
      });
    }
    return rows;
  }, [tools, sortedPolicies]);

  const selectedTool = useMemo(
    () => summaries.find((t) => t.id === selectedToolId) ?? null,
    [summaries, selectedToolId],
  );
  const selection = selectedToolId ? (selectionById.get(selectedToolId) ?? null) : null;
  const selectedAddress = selection?.address ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-sm font-semibold text-foreground">Tools</h2>
          {AsyncResult.isSuccess(tools) && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {summaries.length} {summaries.length === 1 ? "tool" : "tools"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/{-$orgSlug}/policies">Manage policies</Link>
          </Button>
        </div>
      </div>

      {AsyncResult.match(tools, {
        onInitial: () => <ToolsPageSkeleton />,
        onFailure: () => <div className="p-6 text-sm text-destructive">Failed to load tools</div>,
        onSuccess: () =>
          summaries.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div className="text-center">
                <p className="text-sm font-medium text-foreground/70">No tools registered</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add an integration to start discovering tools.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="flex w-72 shrink-0 flex-col border-r border-border/60 lg:w-80 xl:w-[22rem]">
                <ToolTree
                  tools={summaries}
                  selectedToolId={selectedToolId}
                  onSelect={setSelectedToolId}
                  onSetPolicy={(pattern, action) => void policyActions.set(pattern, action)}
                  onClearPolicy={(pattern) => void policyActions.clear(pattern)}
                  policies={sortedPolicies}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {selectedTool && selectedAddress ? (
                  <ToolDetail
                    address={selectedAddress}
                    toolName={selectedTool.name}
                    staticTool={selection?.static}
                    policy={selectedTool.policy}
                    onSetPolicy={(pattern, action) => void policyActions.set(pattern, action)}
                    onClearPolicy={(pattern) => void policyActions.clear(pattern)}
                  />
                ) : (
                  <ToolDetailEmpty hasTools={summaries.length > 0} />
                )}
              </div>
            </div>
          ),
      })}
    </div>
  );
}

function ToolsPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-72 shrink-0 flex-col gap-1 border-r border-border/60 p-3 lg:w-80 xl:w-[22rem]">
        <Skeleton className="mb-2 h-8 w-full rounded-md" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className="h-3.5" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-hidden p-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full rounded-md" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
