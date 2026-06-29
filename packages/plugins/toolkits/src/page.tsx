import { useId, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { ArrowLeftIcon, BoxIcon, PlugIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import {
  createPluginAtomClient,
  useIntegrationPlugins,
  type IntegrationPlugin,
  type PluginPageProps,
} from "@executor-js/sdk/client";
import {
  matchPattern,
  type EffectivePolicy,
  type Integration,
  type Owner,
  type ToolAddress,
  type ToolPolicyAction,
} from "@executor-js/sdk/shared";
import { integrationsOptimisticAtom, toolsAllAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { useOrganizationSlug } from "@executor-js/react/api/organization-context";
import {
  getExecutorApiBaseUrl,
  getExecutorOrganizationHeaders,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { ownerLabel, useOwnerDisplay } from "@executor-js/react/api/owner-display";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@executor-js/react/components/alert-dialog";
import {
  IntegrationFavicon,
  integrationPresetIconUrl,
} from "@executor-js/react/components/integration-favicon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { ToolDetail, ToolDetailEmpty } from "@executor-js/react/components/tool-detail";
import { ToolTree, type ToolSummary } from "@executor-js/react/components/tool-tree";
import { cn } from "@executor-js/react/lib/utils";

import {
  ToolkitsApi,
  type ToolkitConnectionResponse,
  type ToolkitPolicyResponse,
  type ToolkitResponse,
} from "./shared";

const ToolkitsClient = createPluginAtomClient(ToolkitsApi, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});

const toolkitWriteKeys = [
  ReactivityKey.connections,
  ReactivityKey.policies,
  ReactivityKey.tools,
] as const;

const toolkitsAtom = ToolkitsClient.query("toolkits", "list", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.policies],
});

const toolkitPoliciesAtom = Atom.family((toolkitId: string) =>
  ToolkitsClient.query("toolkits", "listPolicies", {
    params: { toolkitId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.policies],
  }),
);

const toolkitConnectionsAtom = Atom.family((toolkitId: string) =>
  ToolkitsClient.query("toolkits", "listConnections", {
    params: { toolkitId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.connections],
  }),
);

const createToolkit = ToolkitsClient.mutation("toolkits", "create");
const removeToolkit = ToolkitsClient.mutation("toolkits", "remove");
const createToolkitPolicy = ToolkitsClient.mutation("toolkits", "createPolicy");
const updateToolkitPolicy = ToolkitsClient.mutation("toolkits", "updatePolicy");
const removeToolkitPolicy = ToolkitsClient.mutation("toolkits", "removePolicy");
const createToolkitConnection = ToolkitsClient.mutation("toolkits", "createConnection");
const removeToolkitConnection = ToolkitsClient.mutation("toolkits", "removeConnection");

type ToolRow = {
  readonly address: ToolAddress;
  readonly integration: string;
  readonly owner?: Owner;
  readonly connection?: string;
  readonly name: string;
  readonly description?: string;
  readonly requiresApproval?: boolean;
  readonly static?: boolean;
};

const comparePolicy = (a: ToolkitPolicyResponse, b: ToolkitPolicyResponse): number => {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const pluginDefaultPolicy = (requiresApproval: boolean | undefined): EffectivePolicy =>
  requiresApproval
    ? { action: "require_approval", source: "plugin-default" }
    : { action: "approve", source: "plugin-default" };

const isLegacyConnectionPolicy = (policy: ToolkitPolicyResponse): boolean => {
  if (policy.action !== "approve") return false;
  const parts = policy.pattern.split(".");
  return parts.at(-1) === "*" && (parts.length === 3 || parts.length === 4);
};

const resolveToolkitPolicy = (
  matchId: string,
  policies: readonly ToolkitPolicyResponse[],
  requiresApproval?: boolean,
): EffectivePolicy => {
  for (const policy of [...policies].sort(comparePolicy)) {
    if (!matchPattern(policy.pattern, matchId)) continue;
    return {
      action: policy.action,
      source: "user",
      pattern: policy.pattern,
      policyId: policy.id,
    };
  }
  return pluginDefaultPolicy(requiresApproval);
};

const toolMatchId = (tool: ToolRow): string =>
  tool.static ? String(tool.address) : String(tool.address).replace(/^tools\./, "");

const toolCanAppearInToolkit = (toolkit: ToolkitResponse, tool: ToolRow): boolean =>
  toolkit.owner === "user" || tool.static === true || tool.owner !== "user";

const toolkitUrlFor = (orgSlug: string | undefined, slug: string): string => {
  const path = orgSlug ? `/${orgSlug}/mcp/toolkits/${slug}` : `/mcp/toolkits/${slug}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
};

const identityPattern = (displayPattern: string): string => displayPattern;

const compareToolkitRows = (a: ToolkitResponse, b: ToolkitResponse): number => {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.name.localeCompare(b.name);
};

const toolkitByRouteSlug = (
  toolkits: readonly ToolkitResponse[],
  slug: string,
): ToolkitResponse | null => {
  const matches = toolkits.filter((toolkit) => toolkit.slug === slug);
  return matches.find((toolkit) => toolkit.owner === "org") ?? matches[0] ?? null;
};

const toolkitCardStyle = { minHeight: "9rem" };
const toolkitShelfStyle = { minHeight: "28.5rem" };
const toolkitGridContainerStyle = { maxWidth: "80rem" };
const toolkitToolTreeStyle = { width: "24rem" };

const neutralToolkitIconClass = "border-border/70 bg-muted/30 text-muted-foreground";

type ToolkitConnectionGroup = {
  readonly id: string;
  readonly owner: Owner;
  readonly integration: string;
  readonly connection: string;
  readonly patterns: readonly string[];
  readonly tools: readonly ToolRow[];
};

type IntegrationMeta = {
  readonly name: string;
  readonly sourceId: string;
  readonly icon?: string | null;
  readonly url?: string;
};

const toolOwner = (tool: ToolRow): Owner => (tool.static ? "org" : (tool.owner ?? "org"));

const toolConnectionName = (tool: ToolRow): string => {
  if (tool.connection && tool.connection.length > 0) return tool.connection;
  return tool.static ? "built-in" : "default";
};

const policyPrefixForTool = (tool: ToolRow): string => {
  const matchId = toolMatchId(tool);
  const integration = String(tool.integration);
  if (tool.connection && tool.connection.length > 0) {
    const connection = String(tool.connection);
    if (tool.owner) {
      const ownerConnectionPrefix = `${integration}.${tool.owner}.${connection}`;
      if (matchId === ownerConnectionPrefix || matchId.startsWith(`${ownerConnectionPrefix}.`)) {
        return ownerConnectionPrefix;
      }
    }
    const connectionPrefix = `${integration}.${connection}`;
    if (matchId === connectionPrefix || matchId.startsWith(`${connectionPrefix}.`)) {
      return connectionPrefix;
    }
  }
  const name = String(tool.name);
  if (name.length > 0 && matchId.endsWith(`.${name}`)) {
    return matchId.slice(0, -name.length - 1);
  }
  const segments = matchId.split(".");
  return segments.length > 1 ? segments.slice(0, -1).join(".") : matchId;
};

const connectionPatternForTool = (tool: ToolRow): string => `${policyPrefixForTool(tool)}.*`;

const compareConnectionGroups = (a: ToolkitConnectionGroup, b: ToolkitConnectionGroup): number => {
  const ownerRank = (owner: Owner) => (owner === "org" ? 0 : 1);
  return (
    ownerRank(a.owner) - ownerRank(b.owner) ||
    a.integration.localeCompare(b.integration) ||
    a.connection.localeCompare(b.connection) ||
    a.id.localeCompare(b.id)
  );
};

const patternSubsumes = (candidate: string, covered: string): boolean => {
  if (candidate === covered) return true;
  if (!candidate.endsWith(".*")) return false;
  const prefix = candidate.slice(0, -1);
  return covered.startsWith(prefix);
};

const reducePolicyPatterns = (patterns: readonly string[]): readonly string[] => {
  const unique = [...new Set(patterns)].sort((a, b) => a.localeCompare(b));
  return unique.filter(
    (pattern) =>
      !unique.some((candidate) => candidate !== pattern && patternSubsumes(candidate, pattern)),
  );
};

const buildConnectionGroups = (tools: readonly ToolRow[]): readonly ToolkitConnectionGroup[] => {
  const groups = new Map<string, ToolkitConnectionGroup & { tools: ToolRow[] }>();
  for (const tool of tools) {
    const owner = toolOwner(tool);
    const key = `${owner}:${tool.integration}:${toolConnectionName(tool)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tools.push(tool);
      continue;
    }
    groups.set(key, {
      id: key,
      owner,
      integration: String(tool.integration),
      connection: toolConnectionName(tool),
      patterns: [],
      tools: [tool],
    });
  }
  return [...groups.values()]
    .map((group) => {
      const sortedTools = [...group.tools].sort(compareTools);
      return {
        ...group,
        patterns: reducePolicyPatterns(sortedTools.map(connectionPatternForTool)),
        tools: sortedTools,
      };
    })
    .sort(compareConnectionGroups);
};

const compareTools = (a: ToolRow, b: ToolRow): number =>
  String(a.name).localeCompare(String(b.name)) || toolMatchId(a).localeCompare(toolMatchId(b));

const connectionTitle = (group: ToolkitConnectionGroup): string =>
  `${ownerLabel(group.owner)} ${group.integration} / ${group.connection}`;

const connectionTitleForHost = (group: ToolkitConnectionGroup, showOwnerLabels: boolean): string =>
  showOwnerLabels ? connectionTitle(group) : `${group.integration} / ${group.connection}`;

const connectionDisplayTitle = (group: ToolkitConnectionGroup, meta: IntegrationMeta): string =>
  group.connection === "built-in" || group.connection === "default" ? meta.name : group.connection;

const connectionDisplaySubtitle = (group: ToolkitConnectionGroup, meta: IntegrationMeta): string =>
  group.connection === "built-in" || group.connection === "default"
    ? `${group.tools.length} ${group.tools.length === 1 ? "tool" : "tools"}`
    : `${meta.name} · ${group.tools.length} ${group.tools.length === 1 ? "tool" : "tools"}`;

const connectionDisplaySubtitleForHost = (
  group: ToolkitConnectionGroup,
  meta: IntegrationMeta,
  showOwnerLabels: boolean,
): string => {
  const subtitle = connectionDisplaySubtitle(group, meta);
  return showOwnerLabels ? `${ownerLabel(group.owner)} · ${subtitle}` : subtitle;
};

const integrationMetaFor = (
  group: ToolkitConnectionGroup,
  integrations: readonly Integration[],
  integrationPlugins: readonly IntegrationPlugin[],
): IntegrationMeta => {
  const integration = integrations.find((row) => String(row.slug) === group.integration);
  const fallbackName = group.integration
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  const source = {
    id: group.integration,
    kind: integration?.kind ?? group.integration,
    name: integration?.name ?? fallbackName,
    url: integration?.displayUrl,
  };
  return {
    name: source.name,
    sourceId: group.integration,
    icon: integrationPresetIconUrl(source, integrationPlugins),
    ...(source.url ? { url: source.url } : {}),
  };
};

type ConfiguredConnectionView = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly pattern: string;
  readonly sourceId: string;
  readonly icon?: string | null;
  readonly url?: string;
};

const configuredConnectionViews = (
  connections: readonly ToolkitConnectionResponse[],
  connectionGroups: readonly ToolkitConnectionGroup[],
  integrations: readonly Integration[],
  integrationPlugins: readonly IntegrationPlugin[],
  showOwnerLabels: boolean,
): readonly ConfiguredConnectionView[] =>
  connections.map((connection) => {
    const group = connectionGroups.find((candidate) =>
      candidate.patterns.includes(connection.pattern),
    );
    if (!group) {
      return {
        id: connection.id,
        title: connection.pattern,
        subtitle: "Configured pattern",
        pattern: connection.pattern,
        sourceId: connection.pattern.split(".")[0] ?? "toolkit",
      };
    }
    const meta = integrationMetaFor(group, integrations, integrationPlugins);
    return {
      id: connection.id,
      title: connectionDisplayTitle(group, meta),
      subtitle: connectionDisplaySubtitleForHost(group, meta, showOwnerLabels),
      pattern: connection.pattern,
      sourceId: meta.sourceId,
      icon: meta.icon,
      ...(meta.url ? { url: meta.url } : {}),
    };
  });

const legacyConnectionPolicyIds = (
  policies: readonly ToolkitPolicyResponse[],
  connectionGroups: readonly ToolkitConnectionGroup[],
  connections: readonly ToolkitConnectionResponse[],
): ReadonlySet<string> => {
  const persistedPatterns = new Set(connections.map((connection) => connection.pattern));
  const connectionPatterns = new Set(connectionGroups.flatMap((group) => group.patterns));
  return new Set(
    policies
      .filter(
        (policy) =>
          isLegacyConnectionPolicy(policy) &&
          connectionPatterns.has(policy.pattern) &&
          !persistedPatterns.has(policy.pattern),
      )
      .map((policy) => policy.id),
  );
};

const configuredConnectionPatterns = (
  connections: readonly ToolkitConnectionResponse[],
  policies: readonly ToolkitPolicyResponse[],
  legacyPolicyIds: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([
    ...connections.map((connection) => connection.pattern),
    ...policies.filter((policy) => legacyPolicyIds.has(policy.id)).map((policy) => policy.pattern),
  ]);

function ToolkitConnectionIconStack(props: { connections: readonly ConfiguredConnectionView[] }) {
  const visibleConnections = props.connections.slice(0, 3);
  if (visibleConnections.length === 0) {
    return (
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md border",
          neutralToolkitIconClass,
        )}
      >
        <BoxIcon className="size-4" />
      </div>
    );
  }

  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/20">
      <div className="flex -space-x-2">
        {visibleConnections.map((connection) => (
          <span
            key={connection.id}
            className="flex size-5 items-center justify-center rounded-sm border border-background bg-card shadow-xs"
          >
            <IntegrationFavicon
              icon={connection.icon}
              sourceId={connection.sourceId}
              url={connection.url}
              size={14}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

const connectionCountLabel = (count: number): string =>
  count === 0 ? "No connections" : `${count} ${count === 1 ? "connection" : "connections"}`;

function ToolkitTile(props: { showOwnerLabels: boolean; toolkit: ToolkitResponse }) {
  const toolkit = props.toolkit;
  const tools = useAtomValue(toolsAllAtom);
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const connections = useAtomValue(toolkitConnectionsAtom(toolkit.id));
  const integrationPlugins = useIntegrationPlugins();
  const visibleTools = useMemo(
    () =>
      AsyncResult.isSuccess(tools)
        ? (tools.value as readonly ToolRow[]).filter((tool) =>
            toolCanAppearInToolkit(toolkit, tool),
          )
        : [],
    [toolkit, tools],
  );
  const connectionGroups = useMemo(() => buildConnectionGroups(visibleTools), [visibleTools]);
  const connectionRows = AsyncResult.isSuccess(connections) ? connections.value.connections : [];
  const integrationRows = AsyncResult.isSuccess(integrations)
    ? (integrations.value as readonly Integration[])
    : [];
  const tileDataReady =
    AsyncResult.isSuccess(connections) &&
    AsyncResult.isSuccess(tools) &&
    AsyncResult.isSuccess(integrations);
  const configuredConnections = tileDataReady
    ? configuredConnectionViews(
        connectionRows,
        connectionGroups,
        integrationRows,
        integrationPlugins,
        props.showOwnerLabels,
      )
    : [];
  return (
    <Link
      to="/{-$orgSlug}/toolkits/$toolkitSlug"
      params={{ toolkitSlug: toolkit.slug }}
      aria-label={`Open toolkit ${toolkit.name}`}
      className="group flex min-h-36 min-w-0 self-start flex-col justify-between rounded-md border border-border/70 bg-card p-3.5 text-left text-card-foreground shadow-xs transition-[border-color,background-color,box-shadow] hover:border-foreground/25 hover:bg-muted/20 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      style={toolkitCardStyle}
    >
      <div className="flex min-w-0 items-start gap-3">
        {tileDataReady ? (
          <ToolkitConnectionIconStack connections={configuredConnections} />
        ) : (
          <Skeleton className="size-9 shrink-0 rounded-md" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{toolkit.name}</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {tileDataReady ? connectionCountLabel(configuredConnections.length) : "Loading"}
          </div>
        </div>
      </div>
    </Link>
  );
}

const addToolkitScopeLabel = (owner: Owner, showOwnerLabels: boolean): string =>
  showOwnerLabels ? (owner === "org" ? "workspace" : "personal") : "";
const addToolkitTitle = (owner: Owner, showOwnerLabels: boolean): string =>
  showOwnerLabels
    ? owner === "org"
      ? "New workspace toolkit"
      : "New personal toolkit"
    : "New toolkit";

function CreateToolkitDialog(props: {
  owner: Owner;
  showOwnerLabels: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const inputId = useId();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const title = addToolkitTitle(props.owner, props.showOwnerLabels);

  const submit = async () => {
    if (!trimmed) return;
    await props.onCreate({ owner: props.owner, name: trimmed });
    setName("");
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        if (!nextOpen) setName("");
      }}
    >
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden rounded-md border-border/80 bg-card p-0 shadow-2xl"
        style={{ width: "min(24rem, calc(100vw - 2rem))" }}
      >
        <form
          className="grid"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader className="px-4 pb-1 pt-4">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">
              Group tools and expose them at a dedicated MCP URL.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 px-4 py-3">
            <Label htmlFor={inputId} className="text-xs text-muted-foreground">
              Toolkit name
            </Label>
            <Input
              id={inputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Support tools"
              autoFocus
              className="h-9"
            />
          </div>
          <DialogFooter className="px-4 pb-4 pt-1">
            <Button
              type="submit"
              size="sm"
              disabled={!trimmed}
              aria-label="Create toolkit"
              className="h-8"
            >
              Create toolkit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddToolkitCard(props: { owner: Owner; showOwnerLabels: boolean; onClick: () => void }) {
  const scopeLabel = addToolkitScopeLabel(props.owner, props.showOwnerLabels);
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={props.onClick}
      aria-label={scopeLabel ? `Add ${scopeLabel} toolkit` : "Add toolkit"}
      className="group flex h-auto min-h-36 min-w-0 self-start items-center justify-center rounded-md border border-dashed border-border/75 bg-card/40 p-0 text-muted-foreground transition-[border-color,background-color,box-shadow,color] hover:border-foreground/25 hover:bg-muted/20 hover:text-foreground hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      style={toolkitCardStyle}
    >
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-md border transition-[border-color,background-color,color,transform]",
          neutralToolkitIconClass,
          "group-hover:scale-105",
        )}
      >
        <PlusIcon className="size-6" />
      </span>
    </Button>
  );
}

function ToolkitSection(props: {
  owner: Owner;
  title?: string;
  showOwnerLabels: boolean;
  toolkits: readonly ToolkitResponse[];
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const rows = [...props.toolkits].sort(compareToolkitRows);
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);
  return (
    <section className="space-y-3">
      {props.title ? (
        <div className="border-b border-border/60 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {props.title}
          </h2>
        </div>
      ) : null}

      <div
        className="grid content-start grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3"
        style={toolkitShelfStyle}
      >
        {rows.map((toolkit) => (
          <ToolkitTile key={toolkit.id} showOwnerLabels={props.showOwnerLabels} toolkit={toolkit} />
        ))}
        <AddToolkitCard
          owner={props.owner}
          showOwnerLabels={props.showOwnerLabels}
          onClick={openCreate}
        />
      </div>

      <CreateToolkitDialog
        owner={props.owner}
        showOwnerLabels={props.showOwnerLabels}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={props.onCreate}
      />
    </section>
  );
}

function ToolkitGrid(props: {
  toolkits: readonly ToolkitResponse[];
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const ownerDisplay = useOwnerDisplay();
  // Toolkit shelves are grouped by owner; the selected toolkit owns the page.
  const workspaceToolkits = props.toolkits.filter((toolkit) => toolkit.owner === "org");
  const personalToolkits = props.toolkits.filter((toolkit) => toolkit.owner === "user");
  if (!ownerDisplay.showOwnerLabels) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
          <ToolkitSection
            owner="org"
            showOwnerLabels={false}
            toolkits={props.toolkits}
            onCreate={props.onCreate}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
        <ToolkitSection
          owner="org"
          showOwnerLabels
          title="Workspace"
          toolkits={workspaceToolkits}
          onCreate={props.onCreate}
        />
        <ToolkitSection
          owner="user"
          showOwnerLabels
          title="Personal"
          toolkits={personalToolkits}
          onCreate={props.onCreate}
        />
      </div>
    </div>
  );
}

function ToolkitContentsEmpty(props: { onManageConnections: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
          <PlugIcon className="size-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-foreground">No connections added</h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          Add a connection to decide what this toolkit exposes.
        </p>
        <Button type="button" size="sm" onClick={props.onManageConnections} className="mt-4">
          Manage connections
        </Button>
      </div>
    </div>
  );
}

function ToolkitToolsPanel(props: {
  tools: readonly ToolSummary[];
  selectedToolId: string | null;
  policies: readonly ToolkitPolicyResponse[];
  onManageConnections: () => void;
  onSelectTool: (toolId: string) => void;
  onSetPolicy: (pattern: string, action: ToolPolicyAction) => void;
  onClearPolicy: (pattern: string) => void;
}) {
  return (
    <div
      role="region"
      aria-label="Toolkit tools"
      className="flex min-h-0 shrink-0 flex-col border-r border-border/60"
      style={toolkitToolTreeStyle}
    >
      {props.tools.length === 0 ? (
        <ToolkitContentsEmpty onManageConnections={props.onManageConnections} />
      ) : (
        <ToolTree
          tools={props.tools}
          selectedToolId={props.selectedToolId}
          onSelect={props.onSelectTool}
          onSetPolicy={props.onSetPolicy}
          onClearPolicy={props.onClearPolicy}
          patternForDisplay={identityPattern}
          policies={props.policies}
          groupByConnection
        />
      )}
    </div>
  );
}

function AddConnectionDialog(props: {
  open: boolean;
  groups: readonly ToolkitConnectionGroup[];
  configuredConnections: readonly ConfiguredConnectionView[];
  hiddenPersonalConnectionCount: number;
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  showOwnerLabels: boolean;
  onOpenChange: (open: boolean) => void;
  onAddPatterns: (patterns: readonly string[]) => Promise<void> | void;
  onRemoveConnection: (connectionId: string) => Promise<void> | void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!trimmedQuery) return props.groups;
    return props.groups.filter((group) => {
      const corpus = [
        connectionTitle(group),
        ...group.patterns,
        ownerLabel(group.owner),
        ...group.tools.flatMap((tool) => [tool.name, tool.description ?? ""]),
      ]
        .join(" ")
        .toLowerCase();
      return corpus.includes(trimmedQuery);
    });
  }, [props.groups, trimmedQuery]);

  const addConnection = async (patterns: readonly string[]) => {
    await props.onAddPatterns(patterns);
  };

  const removeConnection = async (connectionId: string) => {
    await props.onRemoveConnection(connectionId);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden rounded-md border-border/80 bg-card p-0 shadow-2xl"
        style={{
          width: "min(36rem, calc(100vw - 2rem))",
          maxWidth: "min(36rem, calc(100vw - 2rem))",
          maxHeight: "min(42rem, calc(100vh - 4rem))",
        }}
      >
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
              <PlugIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm">Manage connections</DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                Choose which connected accounts this toolkit can use.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border/50 p-3">
            <Label htmlFor={searchId} className="sr-only">
              Search connections and tools
            </Label>
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 transition-colors focus-within:border-primary/35 focus-within:bg-muted/25 focus-within:ring-1 focus-within:ring-primary/15">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections"
                className="h-8 min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
              />
            </div>
            {props.hiddenPersonalConnectionCount > 0 ? (
              <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
                You have {props.hiddenPersonalConnectionCount} personal{" "}
                {props.hiddenPersonalConnectionCount === 1 ? "connection" : "connections"} that{" "}
                {props.hiddenPersonalConnectionCount === 1 ? "is" : "are"} not shown because this is
                a shared toolkit.
              </p>
            ) : null}
          </div>
          <div className="min-h-0 overflow-y-auto p-3" style={{ maxHeight: "32rem" }}>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Connections
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {filteredGroups.length}
              </span>
            </div>
            {filteredGroups.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">
                No connections match.
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-border/70 bg-background/30">
                {filteredGroups.map((group) => {
                  const title = connectionTitleForHost(group, props.showOwnerLabels);
                  const configuredConnection = props.configuredConnections.find((connection) =>
                    group.patterns.includes(connection.pattern),
                  );
                  const added = configuredConnection !== undefined;
                  const meta = integrationMetaFor(
                    group,
                    props.integrations,
                    props.integrationPlugins,
                  );
                  return (
                    <div
                      key={group.id}
                      className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0 hover:bg-muted/20"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30">
                        <IntegrationFavicon
                          icon={meta.icon}
                          sourceId={meta.sourceId}
                          url={meta.url}
                          size={18}
                        />
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-medium text-foreground">
                            {connectionDisplayTitle(group, meta)}
                          </span>
                          {props.showOwnerLabels ? (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {ownerLabel(group.owner)}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[11px] text-muted-foreground">
                            {connectionDisplaySubtitle(group, meta)}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant={added ? "outline" : "default"}
                        size="sm"
                        aria-label={`${added ? "Remove connection" : "Add connection"} ${title}`}
                        onClick={() =>
                          void (added && configuredConnection
                            ? removeConnection(configuredConnection.id)
                            : addConnection(group.patterns))
                        }
                        className={cn(
                          "h-7 shrink-0 px-2.5 text-xs",
                          added
                            ? "border-border/70 bg-transparent text-muted-foreground hover:text-destructive"
                            : "bg-primary/10 text-primary hover:bg-primary/15",
                        )}
                      >
                        {added ? (
                          <Trash2Icon className="size-3.5" />
                        ) : (
                          <PlusIcon className="size-3.5" />
                        )}
                        {added ? "Remove" : "Add"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToolkitHeader(props: {
  toolkit: ToolkitResponse;
  showOwnerLabels: boolean;
  mcpUrl: string;
  onBack: () => void;
  onManageConnections: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-background/95 px-5 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={props.onBack}
            className="-ml-1 h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Toolkits
          </Button>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{props.toolkit.name}</h2>
            {props.showOwnerLabels ? (
              <Badge variant="outline" className="text-[10px]">
                {ownerLabel(props.toolkit.owner)}
              </Badge>
            ) : null}
          </div>
          <div className="mt-2 flex max-w-3xl min-w-0 items-center gap-2 rounded-md bg-muted/20 px-2 py-1 text-xs text-muted-foreground ring-1 ring-border/40">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              MCP
            </span>
            <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {props.mcpUrl}
            </code>
            <CopyButton value={props.mcpUrl} className="-mr-1" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Manage toolkit connections"
            onClick={props.onManageConnections}
            className="h-8 text-muted-foreground hover:text-foreground"
          >
            <PlugIcon className="size-3.5" />
            Connections
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Delete toolkit"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {props.toolkit.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the toolkit and its dedicated MCP endpoint. Connections are not
                  deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={props.onRemove}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

function ToolkitWorkspace(props: {
  toolkit: ToolkitResponse;
  showOwnerLabels: boolean;
  policies: readonly ToolkitPolicyResponse[];
  connections: readonly ToolkitConnectionResponse[];
  tools: readonly ToolRow[];
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  mcpUrl: string;
  onBack: () => void;
  onRemoveToolkit: () => void;
  onAddConnection: (pattern: string) => Promise<void> | void;
  onRemoveConnection: (connectionId: string) => Promise<void> | void;
  onSetPolicy: (pattern: string, action: ToolPolicyAction) => Promise<void> | void;
  onClearPolicy: (pattern: string) => Promise<void> | void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const visibleTools = useMemo(
    () => props.tools.filter((tool) => toolCanAppearInToolkit(props.toolkit, tool)),
    [props.toolkit, props.tools],
  );
  const connectionGroups = useMemo(() => buildConnectionGroups(visibleTools), [visibleTools]);
  const hiddenPersonalConnectionCount = useMemo(() => {
    if (props.toolkit.owner !== "org") return 0;
    return buildConnectionGroups(props.tools.filter((tool) => toolOwner(tool) === "user")).length;
  }, [props.toolkit.owner, props.tools]);
  const configuredConnections = useMemo(
    () =>
      configuredConnectionViews(
        props.connections,
        connectionGroups,
        props.integrations,
        props.integrationPlugins,
        props.showOwnerLabels,
      ),
    [
      connectionGroups,
      props.connections,
      props.integrationPlugins,
      props.integrations,
      props.showOwnerLabels,
    ],
  );
  const legacyPolicyIds = useMemo(
    () => legacyConnectionPolicyIds(props.policies, connectionGroups, props.connections),
    [connectionGroups, props.connections, props.policies],
  );
  const accessPolicies = useMemo(
    () => props.policies.filter((policy) => !legacyPolicyIds.has(policy.id)),
    [legacyPolicyIds, props.policies],
  );
  const connectionPatterns = useMemo(
    () => configuredConnectionPatterns(props.connections, props.policies, legacyPolicyIds),
    [legacyPolicyIds, props.connections, props.policies],
  );
  const configuredToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of visibleTools) {
      const id = toolMatchId(tool);
      if ([...connectionPatterns].some((pattern) => matchPattern(pattern, id))) ids.add(id);
    }
    return ids;
  }, [connectionPatterns, visibleTools]);
  const configuredTools = useMemo(
    () =>
      visibleTools.filter((tool) => configuredToolIds.has(toolMatchId(tool))).sort(compareTools),
    [visibleTools, configuredToolIds],
  );
  const toolkitTools: ToolSummary[] = useMemo(
    () =>
      configuredTools.map((tool) => {
        const id = toolMatchId(tool);
        return {
          id,
          name: id,
          description: tool.description,
          policy: resolveToolkitPolicy(id, accessPolicies, tool.requiresApproval),
          owner: toolOwner(tool),
          connection: toolConnectionName(tool),
          integration: String(tool.integration),
        };
      }),
    [accessPolicies, configuredTools],
  );
  const selectedTool = selectedToolId
    ? (configuredTools.find((tool) => toolMatchId(tool) === selectedToolId) ?? null)
    : null;
  const selectedToolPolicy = selectedTool
    ? (toolkitTools.find((tool) => tool.id === selectedToolId)?.policy ?? null)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ToolkitHeader
        toolkit={props.toolkit}
        showOwnerLabels={props.showOwnerLabels}
        mcpUrl={props.mcpUrl}
        onBack={props.onBack}
        onManageConnections={() => setAddOpen(true)}
        onRemove={props.onRemoveToolkit}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ToolkitToolsPanel
          tools={toolkitTools}
          selectedToolId={selectedToolId}
          policies={accessPolicies}
          onManageConnections={() => setAddOpen(true)}
          onSelectTool={setSelectedToolId}
          onSetPolicy={(pattern, action) => void props.onSetPolicy(pattern, action)}
          onClearPolicy={(pattern) => void props.onClearPolicy(pattern)}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedTool && selectedToolPolicy ? (
            <ToolDetail
              address={selectedTool.address}
              toolName={toolMatchId(selectedTool)}
              staticTool={selectedTool.static === true}
              policy={selectedToolPolicy}
              onSetPolicy={props.onSetPolicy}
              onClearPolicy={props.onClearPolicy}
              patternForDisplay={identityPattern}
            />
          ) : (
            <ToolDetailEmpty hasTools={toolkitTools.length > 0} />
          )}
        </div>
      </div>

      <AddConnectionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        groups={connectionGroups}
        configuredConnections={configuredConnections}
        hiddenPersonalConnectionCount={hiddenPersonalConnectionCount}
        integrations={props.integrations}
        integrationPlugins={props.integrationPlugins}
        showOwnerLabels={props.showOwnerLabels}
        onAddPatterns={async (patterns) => {
          for (const pattern of patterns) {
            await props.onAddConnection(pattern);
          }
        }}
        onRemoveConnection={props.onRemoveConnection}
      />
    </div>
  );
}

function ToolkitTileSkeleton() {
  return (
    <div
      className="flex h-auto min-h-36 min-w-0 self-start items-center justify-center rounded-md border border-dashed border-border/75 bg-card/40 p-0"
      style={toolkitCardStyle}
      aria-hidden="true"
    >
      <Skeleton className="size-12 rounded-md" />
    </div>
  );
}

function ToolkitSectionSkeleton(props: { title?: string }) {
  return (
    <section className="space-y-3" aria-label="Loading toolkits">
      {props.title ? (
        <div className="border-b border-border/60 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {props.title}
          </h2>
        </div>
      ) : null}

      <div
        className="grid content-start grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3"
        style={toolkitShelfStyle}
      >
        <ToolkitTileSkeleton />
      </div>
    </section>
  );
}

function ToolkitGridSkeleton(props: { showOwnerLabels: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
        {props.showOwnerLabels ? (
          <>
            <ToolkitSectionSkeleton title="Workspace" />
            <ToolkitSectionSkeleton title="Personal" />
          </>
        ) : (
          <ToolkitSectionSkeleton />
        )}
      </div>
    </div>
  );
}

function ToolkitDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/60 bg-background/95 px-4 py-3">
        <Skeleton className="mb-3 h-7 w-20 rounded-md" />
        <div className="space-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton className="h-6 w-full max-w-md" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="flex min-h-0 shrink-0 flex-col border-r border-border/60"
          style={toolkitToolTreeStyle}
        >
          <div className="border-b border-border/60 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-14" />
              </div>
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          </div>
          <div className="space-y-1 p-3">
            {Array.from({ length: 9 }).map((_, index) => (
              <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <Skeleton className="size-4 shrink-0 rounded" />
                <Skeleton className="h-3.5" style={{ width: `${48 + ((index * 13) % 38)}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-hidden p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-52" />
            <Skeleton className="h-4 w-full max-w-lg" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-full rounded-md" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolkitDetailView(props: {
  toolkit: ToolkitResponse;
  showOwnerLabels: boolean;
  tools: readonly ToolRow[];
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  orgSlug?: string;
  onBack: () => void;
  onRemoveToolkit: (toolkit: ToolkitResponse) => void;
}) {
  const policies = useAtomValue(toolkitPoliciesAtom(props.toolkit.id));
  const connections = useAtomValue(toolkitConnectionsAtom(props.toolkit.id));
  const doCreatePolicy = useAtomSet(createToolkitPolicy, { mode: "promiseExit" });
  const doUpdatePolicy = useAtomSet(updateToolkitPolicy, { mode: "promiseExit" });
  const doRemovePolicy = useAtomSet(removeToolkitPolicy, { mode: "promiseExit" });
  const doCreateConnection = useAtomSet(createToolkitConnection, { mode: "promiseExit" });
  const doRemoveConnection = useAtomSet(removeToolkitConnection, { mode: "promiseExit" });
  const policyRows = AsyncResult.isSuccess(policies) ? policies.value.policies : [];
  const connectionRows = AsyncResult.isSuccess(connections) ? connections.value.connections : [];

  const setPolicyHandler = async (pattern: string, action: ToolPolicyAction) => {
    const existing = policyRows.find((policy) => policy.pattern === pattern);
    if (existing) {
      await doUpdatePolicy({
        params: { toolkitId: props.toolkit.id, policyId: existing.id },
        payload: { action },
        reactivityKeys: toolkitWriteKeys,
      });
      return;
    }
    await doCreatePolicy({
      params: { toolkitId: props.toolkit.id },
      payload: { pattern, action },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const addConnectionHandler = async (pattern: string) => {
    await doCreateConnection({
      params: { toolkitId: props.toolkit.id },
      payload: { pattern },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const removeConnectionHandler = async (connectionId: string) => {
    await doRemoveConnection({
      params: { toolkitId: props.toolkit.id, connectionId },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const clearPolicyHandler = async (pattern: string) => {
    const existing = policyRows.find((policy) => policy.pattern === pattern);
    if (!existing) return;
    await doRemovePolicy({
      params: { toolkitId: props.toolkit.id, policyId: existing.id },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  if (AsyncResult.isFailure(policies) || AsyncResult.isFailure(connections)) {
    return <div className="p-6 text-sm text-destructive">Failed to load toolkit</div>;
  }
  if (!AsyncResult.isSuccess(policies) || !AsyncResult.isSuccess(connections)) {
    return <ToolkitDetailSkeleton />;
  }

  return (
    <ToolkitWorkspace
      toolkit={props.toolkit}
      showOwnerLabels={props.showOwnerLabels}
      policies={policyRows}
      connections={connectionRows}
      tools={props.tools}
      integrations={props.integrations}
      integrationPlugins={props.integrationPlugins}
      mcpUrl={toolkitUrlFor(props.orgSlug, props.toolkit.slug)}
      onBack={props.onBack}
      onRemoveToolkit={() => props.onRemoveToolkit(props.toolkit)}
      onAddConnection={addConnectionHandler}
      onRemoveConnection={removeConnectionHandler}
      onSetPolicy={setPolicyHandler}
      onClearPolicy={clearPolicyHandler}
    />
  );
}

export function ToolkitsPage(props: PluginPageProps) {
  const navigate = useNavigate();
  const organizationSlug = useOrganizationSlug();
  const ownerDisplay = useOwnerDisplay();
  const integrationPlugins = useIntegrationPlugins();
  const toolkits = useAtomValue(toolkitsAtom);
  const tools = useAtomValue(toolsAllAtom);
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const doCreateToolkit = useAtomSet(createToolkit, { mode: "promiseExit" });
  const doRemoveToolkit = useAtomSet(removeToolkit, { mode: "promiseExit" });
  const selectedToolkitSlug = props.params.toolkitSlug ?? null;

  const toolkitRows = AsyncResult.isSuccess(toolkits) ? toolkits.value.toolkits : [];
  const selectedToolkit =
    selectedToolkitSlug === null ? null : toolkitByRouteSlug(toolkitRows, selectedToolkitSlug);

  const toolRows = AsyncResult.isSuccess(tools) ? (tools.value as readonly ToolRow[]) : [];
  const integrationRows = AsyncResult.isSuccess(integrations)
    ? (integrations.value as readonly Integration[])
    : [];
  const toolkitsReady = AsyncResult.isSuccess(toolkits);
  const toolkitsFailed = AsyncResult.isFailure(toolkits);
  const toolsReady = AsyncResult.isSuccess(tools);
  const toolsFailed = AsyncResult.isFailure(tools);
  const navigateToIndex = () =>
    navigate({
      to: "/{-$orgSlug}/toolkits",
    });

  const createToolkitHandler = async (input: { owner: Owner; name: string }) => {
    await doCreateToolkit({
      payload: input,
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const removeToolkitHandler = async (toolkit: ToolkitResponse) => {
    await doRemoveToolkit({
      params: { toolkitId: toolkit.id },
      reactivityKeys: toolkitWriteKeys,
    });
    await navigateToIndex();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {selectedToolkitSlug === null ? (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-sm font-semibold text-foreground">Toolkits</h1>
            {AsyncResult.isSuccess(toolkits) && (
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
                {toolkitRows.length} {toolkitRows.length === 1 ? "toolkit" : "toolkits"}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {selectedToolkitSlug !== null && !toolkitsReady ? (
        toolkitsFailed ? (
          <div className="p-6 text-sm text-destructive">Failed to load toolkit</div>
        ) : (
          <ToolkitDetailSkeleton />
        )
      ) : !toolkitsReady ? (
        toolkitsFailed ? (
          <div className="p-6 text-sm text-destructive">Failed to load toolkits</div>
        ) : (
          <ToolkitGridSkeleton showOwnerLabels={ownerDisplay.showOwnerLabels} />
        )
      ) : selectedToolkit ? (
        toolsFailed ? (
          <div className="p-6 text-sm text-destructive">Failed to load toolkit tools</div>
        ) : !toolsReady ? (
          <ToolkitDetailSkeleton />
        ) : (
          <ToolkitDetailView
            toolkit={selectedToolkit}
            showOwnerLabels={ownerDisplay.showOwnerLabels}
            tools={toolRows}
            integrations={integrationRows}
            integrationPlugins={integrationPlugins}
            orgSlug={organizationSlug ?? undefined}
            onBack={() => void navigateToIndex()}
            onRemoveToolkit={removeToolkitHandler}
          />
        )
      ) : selectedToolkitSlug !== null ? (
        <div className="flex min-h-0 flex-1 flex-col p-6">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void navigateToIndex()}
            className="mb-4 w-fit -ml-1 text-muted-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Toolkits
          </Button>
          <div className="text-sm text-muted-foreground">Toolkit not found</div>
        </div>
      ) : (
        <ToolkitGrid toolkits={toolkitRows} onCreate={createToolkitHandler} />
      )}
    </div>
  );
}
