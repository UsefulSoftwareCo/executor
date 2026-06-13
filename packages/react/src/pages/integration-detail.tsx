import { Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useAtomSet, useAtomRefresh } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { trackEvent } from "../api/analytics";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  AuthTemplateSlug,
  IntegrationSlug,
  ToolAddress,
  effectivePolicyFromSorted,
  type Connection,
  type Owner,
} from "@executor-js/sdk/shared";
import {
  connectionsAllAtom,
  integrationToolsAllAtom,
  integrationsOptimisticAtom,
  integrationAtom,
  policiesOptimisticAtom,
  refreshConnection,
  removeIntegrationOptimistic,
} from "../api/atoms";
import { connectionWriteKeys, integrationWriteKeys } from "../api/reactivity-keys";
import { ToolTree } from "../components/tool-tree";
import { ToolDetail, ToolDetailEmpty } from "../components/tool-detail";
import type { ToolSummary } from "../components/tool-tree";
import { AccountsSection } from "../components/accounts-section";
import { IntegrationEditSheet } from "../components/metadata-edit-sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs";
import { authMethodsFromDescriptors, type AuthMethod } from "../lib/auth-placements";
import { usePolicyActions } from "../hooks/use-policy-actions";
import { useIntegrationPlugins, type IntegrationAccountHandoff } from "@executor-js/sdk/client";
import { Button } from "../components/button";
import { Skeleton } from "../components/skeleton";

// v2: the route's `namespace` param is the integration slug. Tools belong to
// the integration's per-owner connections; a tool's policy id is
// `<integration>.<tool>` (D17). The wire row also carries the owner + the
// connection name that produced it, so the Tools tab can group by account.
type ToolRow = {
  readonly address: ToolAddress;
  readonly integration: string;
  readonly name: string;
  readonly description: string;
  readonly requiresApproval?: boolean;
  readonly owner: Owner;
  readonly connection: string;
  readonly static?: boolean;
};

export function IntegrationDetailPage(props: { namespace: string }) {
  const { namespace } = props;
  const slug = IntegrationSlug.make(namespace);
  const integrationPlugins = useIntegrationPlugins();
  const integration = useAtomValue(integrationAtom(slug));
  // Tools + connections merge BOTH owners (omit-owner read); each row carries
  // its own owner + connection so the Tools tab can group per account.
  const tools = useAtomValue(integrationToolsAllAtom(slug));
  const policies = useAtomValue(policiesOptimisticAtom);
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);
  const refreshTools = useAtomRefresh(integrationToolsAllAtom(slug));
  const doRemove = useAtomSet(removeIntegrationOptimistic, { mode: "promiseExit" });
  const doRefresh = useAtomSet(refreshConnection, { mode: "promiseExit" });
  // Policies are owner-partitioned on write; the integration policy menu writes
  // Workspace (org) rules, preserving the prior default behavior.
  const policyActions = usePolicyActions("org");
  const navigate = useNavigate();

  // HMR: refresh integration tools when the backend is hot-reloaded
  useEffect(() => {
    if (!import.meta.hot) return;
    const refresh = () => {
      refreshTools();
      refreshIntegrations();
    };
    import.meta.hot.on("executor:backend-updated", refresh);
    return () => {
      import.meta.hot?.off("executor:backend-updated", refresh);
    };
  }, [refreshTools, refreshIntegrations]);

  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editSheetOpen, setEditSheetOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"accounts" | "tools">("accounts");
  const [locationSearch] = useState(() =>
    typeof window === "undefined" ? "" : window.location.search,
  );

  useEffect(() => {
    setConfirmDelete(false);
    setEditSheetOpen(false);
  }, [namespace]);

  const integrationData = AsyncResult.isSuccess(integration) ? integration.value : null;
  const isBuiltInIntegration = namespace === "executor" || integrationData?.kind === "built-in";
  const currentTab = isBuiltInIntegration ? "tools" : activeTab;
  const canRefresh = integrationData?.canRefresh ?? false;
  const canRemove = integrationData?.canRemove ?? false;
  const accountHandoff = useMemo<IntegrationAccountHandoff | null>(() => {
    if (locationSearch.length === 0) return null;
    const search = new URLSearchParams(locationSearch);
    if (search.get("addAccount") !== "1") return null;
    const owner = search.get("owner");
    const template = search.get("template");
    const label = search.get("label");
    return {
      key: locationSearch,
      ...(owner === "org" || owner === "user" ? { owner } : {}),
      ...(template != null && template.length > 0 ? { template } : {}),
      ...(label != null && label.length > 0 ? { label } : {}),
    };
  }, [locationSearch]);

  useEffect(() => {
    if (accountHandoff && !isBuiltInIntegration) {
      setActiveTab("accounts");
    }
  }, [accountHandoff, isBuiltInIntegration]);

  // Find the plugin edit component based on integration kind
  const editPlugin = useMemo(() => {
    if (!integrationData) return null;
    return integrationPlugins.find((p) => p.key === integrationData.kind) ?? null;
  }, [integrationData, integrationPlugins]);

  // Policies are pre-sorted by the server in evaluation order (owner rank, then
  // position ASC). The matcher walks the list and stops at the first hit per
  // owner, mirroring server-side resolution.
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

  // Per-account selection id — uniquely identifies a tool row in the grouped
  // Tools tab: `${owner}:${connection}:${integration}.${name}`. The SAME tool
  // name appears under each connection that serves it, so the id must include
  // the account. The policy id (owner/connection-independent) stays
  // `<integration>.<tool>` for the leaf's `tool.name`.
  const accountToolId = (t: ToolRow): string =>
    `${t.owner}:${t.connection}:${t.integration}.${t.name}`;

  // Per-selection metadata: address (schema), bare tool name (run-panel segment),
  // connection name + its OWN owner (so the run panel pre-selects that account
  // and addresses it under the connection's real owner — never an ambient one).
  const selectionById = useMemo(() => {
    const map = new Map<
      string,
      {
        readonly address: ToolAddress;
        readonly bareName: string;
        readonly connection: string;
        readonly owner: Owner;
        readonly static: boolean;
      }
    >();
    if (!AsyncResult.isSuccess(tools)) return map;
    for (const t of tools.value as readonly ToolRow[]) {
      const id = accountToolId(t);
      if (!map.has(id)) {
        map.set(id, {
          address: t.address,
          bareName: t.name,
          connection: t.connection,
          owner: t.owner,
          static: t.static === true,
        });
      }
    }
    return map;
  }, [tools]);

  // This integration's connections across BOTH owners — the accounts the run
  // panel can invoke a tool against to verify credentials. The panel addresses
  // each connection under its OWN owner (no ambient owner).
  const integrationConnections = useMemo<readonly Connection[]>(() => {
    if (!AsyncResult.isSuccess(connectionsResult)) return [];
    return (connectionsResult.value as readonly Connection[]).filter(
      (connection: Connection) => connection.integration === slug,
    );
  }, [connectionsResult, slug]);

  // Account-grouped tool rows for the Tools tab. NOT deduped across
  // connections: one row per (owner, connection, tool). The leaf's `name` is the
  // policy id `<integration>.<tool>` so leaf policy patterns stay correct, while
  // `id` is account-unique for selection and `owner`/`connection` drive grouping.
  const integrationTools: ToolSummary[] = useMemo(() => {
    if (!AsyncResult.isSuccess(tools)) return [];
    return (tools.value as readonly ToolRow[]).map((t) => {
      // Display id stays connection-agnostic (`integration.<tool>`); the policy
      // match uses the FULL address so connection-aware rules resolve correctly.
      const displayId = `${t.integration}.${t.name}`;
      const matchId = t.static
        ? String(t.address)
        : `${t.integration}.${t.owner}.${t.connection}.${t.name}`;
      return {
        id: accountToolId(t),
        name: displayId,
        description: t.description,
        policy: effectivePolicyFromSorted(matchId, policyList, t.requiresApproval),
        owner: t.owner,
        connection: t.connection,
      };
    });
  }, [tools, policyList]);

  // Distinct tool count (deduped across accounts) for the header — the grouped
  // list repeats a tool per connection, but the count should read like before.
  const distinctToolCount = useMemo(() => {
    const ids = new Set<string>();
    for (const t of integrationTools) ids.add(t.name);
    return ids.size;
  }, [integrationTools]);

  const selectedTool = useMemo(
    () => integrationTools.find((t) => t.id === selectedToolId) ?? null,
    [integrationTools, selectedToolId],
  );
  const selection = selectedToolId ? (selectionById.get(selectedToolId) ?? null) : null;
  const selectedAddress = selection?.address ?? null;
  const selectedBareName = selection?.bareName ?? null;

  // Declared auth methods — derived server-side from the owning plugin's config
  // and carried on the integration catalog response. This is authoritative even
  // when the integration has zero connections (so e.g. an MCP OAuth server shows
  // its OAuth method before any account exists).
  const declaredMethods = useMemo<readonly AuthMethod[]>(() => {
    if (!integrationData) return [];
    return authMethodsFromDescriptors(integrationData.authMethods);
  }, [integrationData]);

  // Connection-inference fallback — only infer from real existing connections.
  // Do not invent an API-key method from an empty catalog response: open/no-auth
  // integrations intentionally have no credential method, and showing an API key
  // there misrepresents the integration.
  const inferredFallbackMethods = useMemo<readonly AuthMethod[]>(() => {
    const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
    const templates = new Set<string>();
    for (const connection of connections as readonly Connection[]) {
      if (connection.integration === slug) templates.add(String(connection.template));
    }
    return Array.from(templates).map((template: string): AuthMethod => {
      const isOAuth = template === "oauth2" || template === "oauth";
      return {
        id: template,
        label: isOAuth ? "OAuth2" : `API key (${template})`,
        kind: isOAuth ? "oauth" : "apikey",
        source: "spec",
        template: AuthTemplateSlug.make(template),
        placements: isOAuth ? [] : [{ carrier: "header", name: "Authorization", prefix: "" }],
      };
    });
  }, [connectionsResult, slug]);

  // Prefer the integration's DECLARED methods; only fall through to inference
  // when the plugin declares none (no projector → empty `authMethods`).
  const accountsMethods = declaredMethods.length > 0 ? declaredMethods : inferredFallbackMethods;

  const handleDelete = async () => {
    if (!integrationData) return;
    setDeleting(true);
    const exit = await doRemove({
      params: { slug },
      reactivityKeys: integrationWriteKeys,
    });
    trackEvent("integration_removed", {
      integration_slug: String(slug),
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      setDeleting(false);
      setConfirmDelete(false);
      return;
    }
    void navigate({ to: "/" });
  };

  const handleRefresh = async () => {
    if (!integrationData) return;
    setRefreshing(true);
    // v2: refresh re-resolves tools per connection. Refresh every connection of
    // this integration for the active owner.
    const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
    const refreshExits: boolean[] = [];
    let connectionCount = 0;
    for (const connection of connections) {
      if (connection.integration !== slug) continue;
      connectionCount++;
      const refreshExit = await doRefresh({
        params: { owner: connection.owner, integration: slug, name: connection.name },
        reactivityKeys: connectionWriteKeys,
      });
      refreshExits.push(Exit.isSuccess(refreshExit));
    }
    trackEvent("integration_refreshed", {
      integration_slug: String(slug),
      connection_count: connectionCount,
      success: connectionCount > 0 && refreshExits.every(Boolean),
    });
    setRefreshing(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {integrationData?.name || namespace}
          </h2>
          {AsyncResult.isSuccess(tools) && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {distinctToolCount} {distinctToolCount === 1 ? "tool" : "tools"}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!confirmDelete && !isBuiltInIntegration && integrationData && (
            <Button variant="outline" size="sm" onClick={() => setEditSheetOpen(true)}>
              Edit
            </Button>
          )}

          {canRefresh && (
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

      <Tabs
        value={currentTab}
        onValueChange={(value: string) => setActiveTab(value as "accounts" | "tools")}
        className="min-h-0 flex-1 gap-0 overflow-hidden"
      >
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <TabsList variant="line">
            {!isBuiltInIntegration && <TabsTrigger value="accounts">Accounts</TabsTrigger>}
            <TabsTrigger value="tools">Tools</TabsTrigger>
          </TabsList>
        </div>

        {/* Hub: integration-level auth methods + accounts. Plugins that
              declare auth methods fill the `accounts` slot (real methods from
              the plugin's config); otherwise we render the generic fallback. */}
        {!isBuiltInIntegration && (
          <TabsContent value="accounts" className="min-h-0 overflow-y-auto">
            {editPlugin?.accounts ? (
              <Suspense fallback={<AccountsSkeleton />}>
                <editPlugin.accounts
                  sourceId={namespace}
                  integrationName={integrationData?.name || namespace}
                  accountHandoff={accountHandoff}
                />
              </Suspense>
            ) : (
              <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
                <AccountsSection
                  integration={slug}
                  integrationName={integrationData?.name || namespace}
                  methods={accountsMethods}
                  accountHandoff={accountHandoff}
                />
              </div>
            )}
          </TabsContent>
        )}

        {/* Tools -- split pane (unchanged behavior) */}
        <TabsContent
          value="tools"
          className="flex min-h-0 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          {AsyncResult.match(tools, {
            onInitial: () => <IntegrationDetailSkeleton />,
            onFailure: () => (
              <div className="p-6 text-sm text-destructive">Failed to load tools</div>
            ),
            onSuccess: () => (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* Left: tool tree */}
                <div className="flex w-72 shrink-0 flex-col border-r border-border/60 lg:w-80 xl:w-[22rem]">
                  <ToolTree
                    tools={integrationTools}
                    selectedToolId={selectedToolId}
                    onSelect={setSelectedToolId}
                    onSetPolicy={(pattern, action) => void policyActions.set(pattern, action)}
                    onClearPolicy={(pattern) => void policyActions.clear(pattern)}
                    policies={sortedPolicies}
                    groupByConnection={!isBuiltInIntegration}
                  />
                </div>

                {/* Right: tool detail with Schema · TypeScript · Run tabs */}
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  {selectedTool && selectedAddress && selectedBareName ? (
                    <ToolDetail
                      address={selectedAddress}
                      toolName={selectedTool.name}
                      policy={selectedTool.policy}
                      onSetPolicy={(pattern, action) => void policyActions.set(pattern, action)}
                      onClearPolicy={(pattern) => void policyActions.clear(pattern)}
                      {...(!selection?.static && selectedBareName
                        ? {
                            integration: slug,
                            runToolName: selectedBareName,
                            connections: integrationConnections,
                            initialConnectionName: selection?.connection ?? null,
                          }
                        : {})}
                    />
                  ) : (
                    <ToolDetailEmpty hasTools={integrationTools.length > 0} />
                  )}
                </div>
              </div>
            ),
          })}
        </TabsContent>
      </Tabs>

      <IntegrationEditSheet
        slug={slug}
        open={editSheetOpen}
        name={integrationData?.name || namespace}
        description={integrationData?.description ?? ""}
        {...(editPlugin?.editSheet ? { pluginSection: editPlugin.editSheet } : {})}
        onOpenChange={setEditSheetOpen}
      />
    </div>
  );
}

function IntegrationDetailSkeleton() {
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

function AccountsSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    </div>
  );
}
