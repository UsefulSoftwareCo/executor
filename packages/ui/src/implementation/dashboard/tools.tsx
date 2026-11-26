import { EmptyState } from "./empty-state.tsx";
import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
import { useState, type ReactNode } from "react";
import type { Tool, ToolRouter, ToolSummary } from "@executor-js/sdk";
import { Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Delete02Icon,
  PencilEdit01Icon,
  SidebarLeft01Icon,
  SourceCodeIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { Query, QueryProps, ToolCatalog } from "../../contracts/dashboard.ts";
import { QueryResult, useQuery } from "./context.tsx";
import { CopyButton } from "./code.tsx";
import { humanize, SchemaSection } from "./tool-schema.tsx";
import { ToolMarkdown } from "./markdown.tsx";
import { Button } from "../components/button.tsx";
import { Empty, SearchInput } from "./common.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { cn } from "../lib/utils.ts";

export function ToolBrowser<E>({
  query,
  detail,
  Failure,
  selected,
  onSelect,
  renderAction,
  empty,
}: QueryProps<ToolCatalog, E> & {
  readonly detail: (tool: ToolSummary) => Query<Tool | undefined, E>;
  readonly selected: string | undefined;
  readonly onSelect: (tool: string) => void;
  readonly renderAction?: (tool: ToolSummary) => ReactNode;
  readonly empty?: ReactNode;
}) {
  const { result, data, refresh } = useQuery(query);
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const tools = Option.isSome(data) ? data.value.tools : [];
  const routers = new Map(
    (Option.isSome(data) ? data.value.routers : []).map((router) => [router.path, router]),
  );
  const filtered = tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const current = tools.find((tool) => tool.name === selected) ?? filtered[0];
  const listToggle = (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-2 hidden shrink-0 text-muted-foreground max-[740px]:inline-flex"
      aria-label={listOpen ? "Hide tools list" : `Show all ${tools.length} tools`}
      aria-expanded={listOpen}
      aria-controls="tools-list-panel"
      onClick={() => setListOpen((open) => !open)}
    >
      <HugeiconsIcon icon={SidebarLeft01Icon} size={18} aria-hidden />
    </Button>
  );
  const tree = buildTree(filtered, routers);
  const { leafLabels } = treeIndex(buildTree(tools, routers));
  const groups = groupKeys(tree);
  const allCollapsed = groups.length > 0 && groups.every((key) => collapsed.has(key));
  const list = (toggle?: ReactNode) => (
    <>
      <AppSectionHeader>
        {toggle}
        <AppSectionTitle className="flex-1">Tools</AppSectionTitle>
        <span className="font-normal tabular-nums text-muted-foreground">
          {filtered.length}
          {search ? ` / ${tools.length}` : ""}
        </span>
        {groups.length > 0 && !search && (
          <Button
            variant="ghost"
            size="xs"
            className="-mr-2 text-muted-foreground"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups))}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </Button>
        )}
      </AppSectionHeader>
      <div className="shrink-0 border-b p-2 [&_.search-field]:w-full">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tools…" />
      </div>
      <nav aria-label="App tools" className="min-h-0 flex-1 overflow-auto p-2">
        {filtered.length === 0 ? (
          <EmptyState size="compact" icon={null} title="No matching tools">
            Try another name.
          </EmptyState>
        ) : (
          <ToolTree
            nodes={tree}
            depth={0}
            current={current?.name}
            collapsed={search ? new Set() : collapsed}
            onToggle={(key) =>
              setCollapsed((previous) => {
                const next = new Set(previous);
                if (!next.delete(key)) next.add(key);
                return next;
              })
            }
            onSelect={(name) => {
              setListOpen(false);
              onSelect(name);
            }}
          />
        )}
      </nav>
    </>
  );
  return (
    <div
      className="tools-section relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape") setListOpen(false);
      }}
    >
      <QueryResult
        result={result}
        Failure={Failure}
        retry={refresh}
        pending={
          <ToolBrowserLoading
            selected={selected}
            searchControl={
              <SearchInput value={search} onChange={setSearch} placeholder="Search tools…" />
            }
          />
        }
      >
        {() =>
          tools.length === 0 ? (
            <>
              <AppSectionHeader>
                <AppSectionTitle>Tools</AppSectionTitle>
                <span className="text-muted-foreground">0</span>
              </AppSectionHeader>
              <div className="p-6">
                {empty ?? (
                  <Empty title="No tools">
                    This app's live definition did not expose any tools.
                  </Empty>
                )}
              </div>
            </>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[var(--app-tools-list-width)_minmax(0,1fr)] overflow-hidden max-[740px]:grid-cols-1">
              <aside className="flex min-h-0 flex-col bg-muted/15 max-[740px]:hidden">
                {list()}
              </aside>
              {listOpen && (
                <div
                  id="tools-list-panel"
                  className="absolute inset-0 z-30 hidden min-h-0 flex-col bg-background animate-in fade-in duration-150 max-[740px]:flex"
                >
                  {list(listToggle)}
                </div>
              )}
              <div className="tool-detail flex min-h-0 min-w-0 flex-col border-l max-[740px]:border-0">
                {current ? (
                  <>
                    <AppSectionHeader>
                      {listToggle}
                      <AppSectionTitle className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                        {current.name}
                      </AppSectionTitle>
                      <CopyButton
                        code={current.name}
                        label="Copy tool name"
                        text="Copy name"
                        inline
                      />
                    </AppSectionHeader>
                    <div
                      key={current.name}
                      className="min-h-0 flex-1 overflow-auto px-8 pt-7 pb-10 max-[740px]:px-4 max-[740px]:pt-5"
                    >
                      <div className="max-w-3xl">
                        <ToolHeading tool={current} label={leafLabels.get(current.name)} />
                        {!sameText(
                          current.description,
                          toolTitle(current, leafLabels.get(current.name)),
                        ) && <ToolDescription description={current.description} />}
                        <ToolSchemas query={detail(current)} Failure={Failure} />
                        {renderAction?.(current)}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    Choose a tool to inspect its schema.
                  </div>
                )}
              </div>
            </div>
          )
        }
      </QueryResult>
    </div>
  );
}

function ToolSchemas<E>({ query, Failure }: QueryProps<Tool | undefined, E>) {
  const { result, refresh } = useQuery(query);
  return (
    <QueryResult
      result={result}
      Failure={Failure}
      retry={refresh}
      pending={
        <div role="status" aria-label="Loading schema">
          <SchemaHeadingSkeleton />
          <SchemaSkeleton />
        </div>
      }
    >
      {(tool) =>
        tool === undefined ? (
          <p className="mt-8 text-sm text-muted-foreground">
            This tool is no longer in the app's catalog.
          </p>
        ) : (
          <>
            <SchemaSection
              title="Inputs"
              subtitle="What to provide when using this tool"
              schema={tool.inputSchema}
              empty="This tool doesn't need any inputs."
              copyLabel="Copy input schema"
            />
            {tool.outputSchema !== undefined && (
              <SchemaSection
                title="Returns"
                subtitle="What the tool sends back"
                schema={tool.outputSchema}
                empty="The tool doesn't describe what it returns."
                copyLabel="Copy output schema"
              />
            )}
          </>
        )
      }
    </QueryResult>
  );
}

function SchemaHeadingSkeleton() {
  return (
    <div className="mt-8 mb-3">
      <div className="text-sm font-semibold">Inputs</div>
      <div className="text-xs text-muted-foreground">What to provide when using this tool</div>
    </div>
  );
}

function SchemaSkeleton() {
  return (
    <div aria-hidden className="space-y-3 rounded-lg border bg-card p-4">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}

export function ToolBrowserLoading({
  label = "Loading tools",
  selected,
  searchControl,
}: {
  readonly label?: string;
  readonly selected?: string | undefined;
  readonly searchControl?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="grid min-h-0 flex-1 grid-cols-[var(--app-tools-list-width)_minmax(0,1fr)] max-[740px]:grid-cols-1"
    >
      <div className="max-[740px]:hidden">
        <AppSectionHeader>
          <AppSectionTitle>Tools</AppSectionTitle>
        </AppSectionHeader>
        <div className="border-b p-2 [&_.search-field]:w-full">
          {searchControl ?? <Skeleton className="h-8.75 w-full" />}
        </div>
        <div className="space-y-5 p-4" aria-hidden>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </div>
      <div className="min-w-0 border-l max-[740px]:border-0">
        <AppSectionHeader>
          <span className="-ml-2 hidden size-11 shrink-0 items-center justify-center text-muted-foreground max-[740px]:inline-flex">
            <HugeiconsIcon icon={SidebarLeft01Icon} size={18} aria-hidden />
          </span>
          {selected ? (
            <AppSectionTitle className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {selected}
            </AppSectionTitle>
          ) : (
            <Skeleton className="h-3 w-36" />
          )}
          <CopyButton code={undefined} label="Copy tool name" text="Copy name" inline />
        </AppSectionHeader>
        <div aria-hidden className="min-w-0 px-8 pt-7 pb-10 max-[740px]:px-4 max-[740px]:pt-5">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3.5">
              <Skeleton className="size-10 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
            <Skeleton className="mt-5 h-4 w-3/4" />
            <SchemaHeadingSkeleton />
            <SchemaSkeleton />
          </div>
        </div>
      </div>
      <span className="sr-only">{label}…</span>
    </div>
  );
}

function ToolDescription({ description }: { readonly description: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = description || "This tool does not include a description.";
  const long = text.length > 360 || text.split(/\r?\n/).length > 6;
  return (
    <div className="tool-description text-muted-foreground text-sm leading-[1.65] mt-5 wrap-anywhere [&_p]:[margin:0_0_9px] [&_p:last-child]:mb-0 [&_ul]:[margin:6px_0_9px_18px] [&_ol]:[margin:6px_0_9px_18px] [&_code]:font-mono [&_code]:text-[11px] [&_a]:underline [&_a]:underline-offset-[2px] [&_h1]:text-foreground [&_h1]:text-[13px] [&_h1]:font-semibold [&_h1]:[margin:10px_0_5px] [&_h2]:text-foreground [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:[margin:10px_0_5px] [&_h3]:text-foreground [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:[margin:10px_0_5px]">
      <div
        className={cn(
          long &&
            !expanded &&
            "is-collapsed [.tool-description_>_&]:max-h-28 [.tool-description_>_&]:overflow-hidden [.tool-description_>_&]:relative [.tool-description_>_&::after]:[content:''] [.tool-description_>_&::after]:absolute [.tool-description_>_&::after]:right-0 [.tool-description_>_&::after]:bottom-0 [.tool-description_>_&::after]:left-0 [.tool-description_>_&::after]:h-8 [.tool-description_>_&::after]:[background:linear-gradient(transparent,_var(--background))] [.tool-description_>_&::after]:pointer-events-none",
        )}
      >
        <ToolMarkdown>{text}</ToolMarkdown>
      </div>
      {long && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="tool-description-toggle mt-1.5 p-0 h-auto relative z-1"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

type ToolNode =
  | {
      readonly kind: "group";
      readonly key: string;
      readonly label: string;
      readonly description: string | undefined;
      readonly children: readonly ToolNode[];
      readonly size: number;
    }
  | { readonly kind: "tool"; readonly tool: ToolSummary; readonly label: string };

interface Entry {
  readonly tool: ToolSummary;
  readonly segments: readonly string[];
}

type Routers = ReadonlyMap<string, ToolRouter>;

function buildTree(tools: readonly ToolSummary[], routers: Routers): readonly ToolNode[] {
  return nest(
    tools.map((tool) => ({ tool, segments: tool.name.split(".") })),
    "",
    "",
    "",
    routers,
  );
}

const underscorePrefix = (segment: string) => {
  const at = segment.indexOf("_");
  return at > 0 && at < segment.length - 1 ? segment.slice(0, at) : undefined;
};

const withoutGroupPrefix = (entry: Entry, group: string): Entry => {
  const [only, ...rest] = entry.segments;
  if (only === undefined || rest.length > 0) return entry;
  const prefix = underscorePrefix(only);
  return prefix !== undefined && prefix.toLowerCase() === group.toLowerCase()
    ? { tool: entry.tool, segments: [only.slice(prefix.length + 1)] }
    : entry;
};

function nest(
  nested: readonly Entry[],
  parent: string,
  parentGroup: string,
  path: string | undefined,
  routers: Routers,
): readonly ToolNode[] {
  const entries =
    parentGroup === "" ? nested : nested.map((e) => withoutGroupPrefix(e, parentGroup));
  const shared = new Map<string, number>();
  for (const entry of entries) {
    const prefix = entry.segments.length === 1 ? underscorePrefix(entry.segments[0]!) : undefined;
    if (prefix !== undefined) shared.set(prefix, (shared.get(prefix) ?? 0) + 1);
  }
  const order: Array<
    { readonly group: string; readonly router: boolean } | { readonly entry: Entry }
  > = [];
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const [head = "", ...rest] = entry.segments;
    const prefix = rest.length === 0 ? underscorePrefix(head) : undefined;
    const split =
      rest.length > 0
        ? { group: head, segments: rest, router: true }
        : prefix !== undefined && (shared.get(prefix) ?? 0) > 1
          ? { group: prefix, segments: [head.slice(prefix.length + 1)], router: false }
          : undefined;
    if (split === undefined) {
      order.push({ entry });
      continue;
    }
    const members = groups.get(split.group);
    if (members === undefined) {
      groups.set(split.group, [{ tool: entry.tool, segments: split.segments }]);
      order.push({ group: split.group, router: split.router });
    } else members.push({ tool: entry.tool, segments: split.segments });
  }
  return order.map((item): ToolNode => {
    if ("entry" in item)
      return { kind: "tool", tool: item.entry.tool, label: humanize(item.entry.segments[0]!) };
    const members = groups.get(item.group) ?? [];
    const key = parent === "" ? item.group : `${parent}/${item.group}`;
    const routerPath =
      item.router && path !== undefined
        ? path === ""
          ? item.group
          : `${path}.${item.group}`
        : undefined;
    const router = routerPath === undefined ? undefined : routers.get(routerPath);
    return {
      kind: "group",
      key,
      label: router?.title ?? humanize(item.group),
      description: router?.description,
      children: nest(members, key, item.group, routerPath, routers),
      size: members.length,
    };
  });
}

function groupKeys(nodes: readonly ToolNode[]): readonly string[] {
  return nodes.flatMap((node) =>
    node.kind === "group" ? [node.key, ...groupKeys(node.children)] : [],
  );
}

function treeIndex(nodes: readonly ToolNode[]) {
  const leafLabels = new Map<string, string>();
  const walk = (level: readonly ToolNode[]) => {
    for (const node of level) {
      if (node.kind === "group") walk(node.children);
      else leafLabels.set(node.tool.name, node.label);
    }
  };
  walk(nodes);
  return { leafLabels };
}

function ToolTree({
  nodes,
  depth,
  current,
  collapsed,
  onToggle,
  onSelect,
}: {
  readonly nodes: readonly ToolNode[];
  readonly depth: number;
  readonly current: string | undefined;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onSelect: (tool: string) => void;
}) {
  return (
    <ul className={cn("space-y-px", depth > 0 && "ml-[15px] border-l pl-1.5")}>
      {nodes.map((node) =>
        node.kind === "group" ? (
          <li key={`group:${node.key}`}>
            <button
              type="button"
              aria-expanded={!collapsed.has(node.key)}
              onClick={() => onToggle(node.key)}
              className="flex min-h-7.5 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-ring max-[740px]:min-h-11"
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={14}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform",
                  !collapsed.has(node.key) && "rotate-90",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{node.label}</span>
              <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
                {node.size}
              </span>
            </button>
            {node.description !== undefined && !collapsed.has(node.key) && (
              <p
                title={node.description}
                className="mb-1 ml-[22px] line-clamp-2 pr-2 text-xs leading-normal text-muted-foreground"
              >
                {node.description}
              </p>
            )}
            {!collapsed.has(node.key) && (
              <ToolTree
                nodes={node.children}
                depth={depth + 1}
                current={current}
                collapsed={collapsed}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        ) : (
          <li key={`tool:${node.tool.name}`}>
            <button
              type="button"
              title={node.tool.name}
              aria-label={node.tool.name}
              aria-pressed={current === node.tool.name}
              onClick={() => onSelect(node.tool.name)}
              className={cn(
                "flex min-h-7.5 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-ring max-[740px]:min-h-11",
                current === node.tool.name && "bg-muted font-medium text-foreground",
              )}
            >
              <HugeiconsIcon
                icon={effectIcon(toolEffect(node.tool))}
                size={14}
                strokeWidth={1.7}
                className="shrink-0 opacity-70"
                aria-hidden
              />
              <span className="truncate">{node.label}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

type Effect = "read" | "change" | "delete" | "unknown";

function toolEffect(tool: ToolSummary): Effect {
  const readOnly = tool.readOnly ?? tool.annotations?.readOnlyHint;
  if (readOnly === true) return "read";
  if (tool.annotations?.destructiveHint === true) return "delete";
  return readOnly === false ? "change" : "unknown";
}

const effectIcon = (effect: Effect) => {
  switch (effect) {
    case "read":
      return ViewIcon;
    case "change":
      return PencilEdit01Icon;
    case "delete":
      return Delete02Icon;
    case "unknown":
      return SourceCodeIcon;
  }
};

const effects: Record<Effect, { readonly label?: string; readonly badge?: string }> = {
  read: { label: "Only reads data", badge: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  change: { label: "Makes changes", badge: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  delete: { label: "Can delete data", badge: "bg-red-500/10 text-red-700 dark:text-red-300" },
  unknown: {},
};

const sameText = (a: string, b: string) =>
  a
    .trim()
    .replace(/[.\s]+$/, "")
    .toLowerCase() === b.trim().toLowerCase();

const toolTitle = (tool: ToolSummary, label: string | undefined) =>
  tool.title ?? tool.annotations?.title ?? label ?? humanize(tool.name);

function ToolHeading({
  tool,
  label,
}: {
  readonly tool: ToolSummary;
  readonly label: string | undefined;
}) {
  const kind = toolEffect(tool);
  const effect = effects[kind];
  return (
    <div className="flex items-start gap-3.5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
        <HugeiconsIcon icon={effectIcon(kind)} size={19} strokeWidth={1.7} aria-hidden />
      </span>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight wrap-anywhere">
          {toolTitle(tool, label)}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs text-muted-foreground wrap-anywhere">{tool.name}</code>
          {effect.label !== undefined && (
            <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", effect.badge)}>
              {effect.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
