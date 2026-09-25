import { EmptyState } from "./empty-state.tsx";
import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
import { useState, type ReactNode } from "react";
import type { Tool, ToolSummary } from "@executor-js/sdk";
import { Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { SidebarLeft01Icon, SourceCodeIcon } from "@hugeicons/core-free-icons";
import type { Query, QueryProps } from "../../contracts/dashboard.ts";
import { QueryResult, useQuery } from "./context.tsx";
import { Code, CopyButton } from "./code.tsx";
import { ToolMarkdown } from "./markdown.tsx";
import { Button } from "../components/button.tsx";
import { Empty, SearchInput } from "./common.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Stable list/inspector layout. Hosts choose navigation and any tool execution controls.
 * The list carries no schemas; the selected tool's schemas are read through detail.
 * On phones the inspector fills the section and the list opens as a panel over it.
 */
export function ToolBrowser<E>({
  query,
  detail,
  Failure,
  selected,
  onSelect,
  renderAction,
}: QueryProps<readonly ToolSummary[], E> & {
  /** Undefined when the tool left the catalog after the list was read. */
  readonly detail: (tool: ToolSummary) => Query<Tool | undefined, E>;
  readonly selected: string | undefined;
  readonly onSelect: (tool: string) => void;
  readonly renderAction?: (tool: ToolSummary) => ReactNode;
}) {
  const { result, data, refresh } = useQuery(query);
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const tools = Option.isSome(data) ? data.value : [];
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
  const list = (toggle?: ReactNode) => (
    <>
      <AppSectionHeader>
        {toggle}
        <AppSectionTitle className="flex-1">Tools</AppSectionTitle>
        <span className="font-normal tabular-nums text-muted-foreground">
          {filtered.length}
          {search ? ` / ${tools.length}` : ""}
        </span>
      </AppSectionHeader>
      <div className="shrink-0 border-b p-2 [&_.search-field]:w-full">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tools…" />
      </div>
      <nav aria-label="App tools" className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {filtered.length === 0 ? (
          <EmptyState size="compact" icon={null} title="No matching tools">
            Try another name.
          </EmptyState>
        ) : (
          filtered.map((tool) => (
            <button
              type="button"
              key={tool.name}
              title={tool.name}
              aria-pressed={current?.name === tool.name}
              onClick={() => {
                setListOpen(false);
                onSelect(tool.name);
              }}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-ring max-[740px]:min-h-11",
                current?.name === tool.name && "bg-muted font-medium text-foreground",
              )}
            >
              <HugeiconsIcon
                icon={SourceCodeIcon}
                size={15}
                strokeWidth={1.7}
                className="shrink-0 text-muted-foreground"
                aria-hidden
              />
              <code className="truncate">{tool.name}</code>
            </button>
          ))
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
                <Empty title="No tools">This app's live definition did not expose any tools.</Empty>
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
                      <h2
                        className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium"
                        title={current.name}
                      >
                        {current.name}
                      </h2>
                      <CopyButton code={current.name} label="Copy tool name" inline />
                    </AppSectionHeader>
                    {/* One key per tool: every part of the inspector remounts together. */}
                    <div
                      key={current.name}
                      className="min-h-0 flex-1 overflow-auto px-6 pb-6 max-[740px]:px-4"
                    >
                      <ToolDescription description={current.description} />
                      <ToolSchemas query={detail(current)} Failure={Failure} />
                      {renderAction?.(current)}
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

/** The selected tool's schemas, read on selection rather than with the list. */
function ToolSchemas<E>({ query, Failure }: QueryProps<Tool | undefined, E>) {
  const { result, refresh } = useQuery(query);
  return (
    <QueryResult
      result={result}
      Failure={Failure}
      retry={refresh}
      pending={
        <div role="status" aria-label="Loading schema">
          <div className="mb-2.5 mt-6 text-xs font-medium text-muted-foreground">Input schema</div>
          <SchemaSkeleton />
        </div>
      }
    >
      {(tool) =>
        tool === undefined ? (
          <p className="mt-6 text-sm text-muted-foreground">
            This tool is no longer in the app's catalog.
          </p>
        ) : (
          <>
            <div className="mb-2.5 mt-6 text-xs font-medium text-muted-foreground">
              Input schema
            </div>
            <Code
              code={JSON.stringify(tool.inputSchema, null, 2)}
              copyable
              copyLabel="Copy input schema"
            />
            {tool.outputSchema !== undefined && (
              <>
                <div className="mb-2.5 mt-6 text-xs font-medium text-muted-foreground">
                  Output schema
                </div>
                <Code
                  code={JSON.stringify(tool.outputSchema, null, 2)}
                  copyable
                  copyLabel="Copy output schema"
                />
              </>
            )}
          </>
        )
      }
    </QueryResult>
  );
}

function SchemaSkeleton() {
  return (
    <div aria-hidden className="space-y-3 rounded-lg bg-muted p-4">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}

/** Retain the tool browser's list and detail geometry while its reads are pending. */
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
            <AppSectionTitle className="min-w-0 flex-1 truncate font-mono">
              {selected}
            </AppSectionTitle>
          ) : (
            <Skeleton className="h-3 w-36" />
          )}
          <CopyButton code={undefined} label="Copy tool name" inline />
        </AppSectionHeader>
        <div aria-hidden className="min-w-0 px-6 pb-6 max-[740px]:px-4">
          <Skeleton className="mt-3.5 h-5 w-3/4" />
          <div className="mb-2.5 mt-6 text-xs font-medium text-muted-foreground">Input schema</div>
          <SchemaSkeleton />
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
    <div className="tool-description text-muted-foreground text-[13px] leading-[1.65] mt-3.5 wrap-anywhere [&_p]:[margin:0_0_9px] [&_p:last-child]:mb-0 [&_ul]:[margin:6px_0_9px_18px] [&_ol]:[margin:6px_0_9px_18px] [&_code]:font-mono [&_code]:text-[11px] [&_a]:underline [&_a]:underline-offset-[2px] [&_h1]:text-foreground [&_h1]:text-[13px] [&_h1]:font-semibold [&_h1]:[margin:10px_0_5px] [&_h2]:text-foreground [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:[margin:10px_0_5px] [&_h3]:text-foreground [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:[margin:10px_0_5px]">
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
