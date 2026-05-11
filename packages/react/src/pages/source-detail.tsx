import { Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useAtomSet, useAtomRefresh } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { effectivePolicyFromSorted } from "@executor-js/sdk";
import {
  policiesOptimisticAtom,
  sourceToolsAtom,
  sourcesOptimisticAtom,
  sourceAtom,
  removeSourceOptimistic,
  refreshSource,
} from "../api/atoms";
import { sourceWriteKeys } from "../api/reactivity-keys";
import { ToolTree } from "../components/tool-tree";
import { ToolDetail, ToolDetailEmpty } from "../components/tool-detail";
import type { ToolSummary } from "../components/tool-tree";
import { useScope } from "../hooks/use-scope";
import { usePolicyActions } from "../hooks/use-policy-actions";
import { useSourcePlugins } from "@executor-js/sdk/client";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Skeleton } from "../components/skeleton";

export function SourceDetailPage(props: { namespace: string }) {
  const { namespace } = props;
  const sourcePlugins = useSourcePlugins();
  const scopeId = useScope();
  const source = useAtomValue(sourceAtom(namespace, scopeId));
  const tools = useAtomValue(sourceToolsAtom(namespace, scopeId));
  const policies = useAtomValue(policiesOptimisticAtom(scopeId));
  const refreshSources = useAtomRefresh(sourcesOptimisticAtom(scopeId));
  const refreshTools = useAtomRefresh(sourceToolsAtom(namespace, scopeId));
  const doRemove = useAtomSet(removeSourceOptimistic(scopeId), { mode: "promiseExit" });
  const doRefresh = useAtomSet(refreshSource, { mode: "promiseExit" });
  const policyActions = usePolicyActions(scopeId);
  const navigate = useNavigate();

  // HMR: refresh source tools when the backend is hot-reloaded
  useEffect(() => {
    if (!import.meta.hot) return;
    const refresh = () => {
      refreshTools();
      refreshSources();
    };
    import.meta.hot.on("executor:backend-updated", refresh);
    return () => {
      import.meta.hot?.off("executor:backend-updated", refresh);
    };
  }, [refreshTools, refreshSources]);

  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setConfirmDelete(false);
  }, [namespace]);

  const sourceData = AsyncResult.isSuccess(source) ? source.value : null;
  const sourceOwnerScopeId = sourceData?.scopeId ?? scopeId;
  const canRefresh = sourceData ? (sourceData.canRefresh ?? true) : false;
  const canRemove = sourceData ? (sourceData.canRemove ?? true) : false;
  const canEdit = sourceData ? (sourceData.canEdit ?? false) : false;

  // Find the plugin edit component based on source kind
  const editPlugin = useMemo(() => {
    if (!sourceData) return null;
    return sourcePlugins.find((p) => p.key === sourceData.kind) ?? null;
  }, [sourceData, sourcePlugins]);

  // Policies are pre-sorted by the server in evaluation order
  // (innermost scope first, then position ASC). The matcher walks the
  // list and stops at the first hit, mirroring server-side resolution.
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

  const sourceTools: ToolSummary[] = useMemo(() => {
    if (!AsyncResult.isSuccess(tools)) return [];
    return tools.value.map(
      (t: {
        readonly id: string;
        readonly name: string;
        readonly pluginId: string;
        readonly description?: string;
        readonly requiresApproval?: boolean;
      }) => ({
        id: t.id,
        // Tree path + saved pattern must be the canonical tool id, so
        // policy rules created from the row actually match at resolve
        // time. The leaf label is still the short last segment.
        name: t.id,
        pluginKey: t.pluginId,
        description: t.description,
        policy: effectivePolicyFromSorted(t.id, policyList, t.requiresApproval),
      }),
    );
  }, [tools, policyList]);

  const selectedTool = useMemo(
    () => sourceTools.find((t) => t.id === selectedToolId) ?? null,
    [sourceTools, selectedToolId],
  );

  const handleDelete = async () => {
    if (!sourceData) return;
    setDeleting(true);
    const exit = await doRemove({
      params: { scopeId: sourceOwnerScopeId, sourceId: namespace },
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setDeleting(false);
      setConfirmDelete(false);
      return;
    }
    void navigate({ to: "/" });
  };

  const handleRefresh = async () => {
    if (!sourceData) return;
    setRefreshing(true);
    await doRefresh({
      params: { scopeId: sourceOwnerScopeId, sourceId: namespace },
      reactivityKeys: sourceWriteKeys,
    });
    setRefreshing(false);
  };

  const handleEditSave = () => {
    setEditing(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {sourceData?.name ?? namespace}
          </h2>
          {sourceData?.runtime && (
            <Badge className="bg-muted text-muted-foreground">built-in</Badge>
          )}
          {(!sourceData?.runtime || sourceData.kind !== "built-in") && (
            <Badge variant="secondary">{sourceData?.kind ?? "source"}</Badge>
          )}
          {AsyncResult.isSuccess(tools) && !editing && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {sourceTools.length} {sourceTools.length === 1 ? "tool" : "tools"}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canEdit && editPlugin && !editing && !confirmDelete && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}

          {editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
              Back to tools
            </Button>
          )}

          {canRefresh && !editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
          )}

          {canRemove &&
            !editing &&
            (confirmDelete ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting..." : "Confirm Delete"}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
              >
                Delete
              </Button>
            ))}
        </div>
      </div>

      {/* Edit view */}
      {editing && editPlugin ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-6 py-8">
            <Suspense fallback={<EditFormSkeleton />}>
              <editPlugin.edit sourceId={namespace} onSave={handleEditSave} />
            </Suspense>
          </div>
        </div>
      ) : (
        <>
          {editPlugin?.summary && (
            <Suspense fallback={null}>
              <editPlugin.summary
                sourceId={namespace}
                variant="panel"
                onAction={() => setEditing(true)}
              />
            </Suspense>
          )}

          {/* Content -- split pane */}
          {AsyncResult.match(tools, {
            onInitial: () => <SourceDetailSkeleton />,
            onFailure: () => (
              <div className="p-6 text-sm text-destructive">Failed to load tools</div>
            ),
            onSuccess: () => (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* Left: tool tree */}
                <div className="flex w-72 shrink-0 flex-col border-r border-border/60 lg:w-80 xl:w-[22rem]">
                  <ToolTree
                    tools={sourceTools}
                    selectedToolId={selectedToolId}
                    onSelect={setSelectedToolId}
                    onSetPolicy={(pattern, action) => void policyActions.set(pattern, action)}
                    onClearPolicy={(pattern) => void policyActions.clear(pattern)}
                    policies={sortedPolicies}
                  />
                </div>

                {/* Right: tool detail */}
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  {selectedTool ? (
                    <ToolDetail
                      toolId={selectedTool.id}
                      toolName={selectedTool.name}
                      toolDescription={selectedTool.description}
                      scopeId={scopeId}
                      policy={selectedTool.policy}
                      onSetPolicy={(pattern, action) => void policyActions.set(pattern, action)}
                      onClearPolicy={(pattern) => void policyActions.clear(pattern)}
                    />
                  ) : (
                    <ToolDetailEmpty hasTools={sourceTools.length > 0} />
                  )}
                </div>
              </div>
            ),
          })}
        </>
      )}
    </div>
  );
}

function SourceDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left: tool tree skeleton */}
      <div className="flex w-72 shrink-0 flex-col gap-1 border-r border-border/60 p-3 lg:w-80 xl:w-[22rem]">
        <Skeleton className="mb-2 h-8 w-full rounded-md" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className="h-3.5" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
          </div>
        ))}
      </div>

      {/* Right: tool detail skeleton */}
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
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
    </div>
  );
}

function EditFormSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Skeleton className="h-9 w-20 rounded-md" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
    </div>
  );
}
