import { useDeferredValue, useId, useState } from "react";
import type { ToolName, ToolSummary } from "@executor-js/sdk";
import type { QueryProps } from "../../contracts/dashboard.ts";
import { Checkbox } from "../components/checkbox.tsx";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { QueryView } from "./context.tsx";
import { useIncrementalList } from "./incremental-list.tsx";

type Filter = "all" | "read" | "write" | "selected";

const filters: readonly { readonly value: Filter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "selected", label: "Selected" },
];

export function ConnectionToolPicker<E>({
  query,
  Failure,
  names,
  onChange,
}: QueryProps<readonly ToolSummary[], E> & {
  readonly names: readonly ToolName[];
  readonly onChange: (names: readonly ToolName[]) => void;
}) {
  return (
    <QueryView
      query={query}
      Failure={Failure}
      pending={
        <p role="status" className="px-4 py-6 text-xs text-muted-foreground">
          Loading tools…
        </p>
      }
    >
      {(tools) => <ToolList tools={tools} names={names} onChange={onChange} />}
    </QueryView>
  );
}

function ToolList({
  tools,
  names,
  onChange,
}: {
  readonly tools: readonly ToolSummary[];
  readonly names: readonly ToolName[];
  readonly onChange: (names: readonly ToolName[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const deferred = useDeferredValue(search.trim().toLowerCase());
  const id = useId();
  const selected = new Set(names);
  const catalog = new Set<string>(tools.map((tool) => tool.name));
  const missing = names.filter((name) => !catalog.has(name));
  const matching = tools.filter(
    (tool) =>
      (filter === "all" ||
        (filter === "read" && tool.readOnly === true) ||
        (filter === "write" && tool.readOnly !== true) ||
        (filter === "selected" && selected.has(tool.name))) &&
      (deferred === "" || `${tool.name} ${tool.description}`.toLowerCase().includes(deferred)),
  );
  const { count, sentinel } = useIncrementalList(matching.length, `${deferred}:${filter}`);
  const counts: Record<Filter, number> = {
    all: tools.length,
    read: tools.filter((tool) => tool.readOnly === true).length,
    write: tools.filter((tool) => tool.readOnly !== true).length,
    selected: names.length,
  };
  const unselectedMatches = matching.filter((tool) => !selected.has(tool.name));
  const selectedMatches = matching.filter((tool) => selected.has(tool.name));
  const scope = matching.length === tools.length ? "all" : "matching";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <Input
          aria-label="Search tools"
          placeholder={`Search ${tools.length.toLocaleString("en-US")} tools…`}
          className="h-8 min-w-40 flex-1 text-[13px]"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div role="radiogroup" aria-label="Filter tools" className="flex rounded-md border p-0.5">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                filter === item.value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                {counts[item.value].toLocaleString("en-US")}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="h-72 overflow-y-auto">
        {matching.slice(0, count).map((tool, index) => (
          <label
            key={tool.name}
            htmlFor={`${id}-${index}`}
            className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-muted/40"
          >
            <Checkbox
              id={`${id}-${index}`}
              checked={selected.has(tool.name)}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...names, tool.name]
                    : names.filter((name) => name !== tool.name),
                )
              }
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs">{tool.name}</span>
              <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                {tool.description}
              </span>
            </span>
            <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tool.readOnly === true ? "Read" : "Write"}
            </span>
          </label>
        ))}
        {sentinel}
        {matching.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {tools.length === 0
              ? "This app has no available tools."
              : filter === "selected" && names.length === 0
                ? "No tools selected yet."
                : "No tools match."}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {names.length.toLocaleString("en-US")} of {tools.length.toLocaleString("en-US")} selected
          {missing.length > 0 && (
            <>
              {" · "}
              {missing.length} no longer in this app{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => onChange(names.filter((name) => catalog.has(name)))}
              >
                Remove
              </button>
            </>
          )}
        </span>
        <span className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={unselectedMatches.length === 0}
            onClick={() => onChange([...names, ...unselectedMatches.map((tool) => tool.name)])}
          >
            Select {scope} ({unselectedMatches.length.toLocaleString("en-US")})
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectedMatches.length === 0}
            onClick={() => {
              const removed = new Set<string>(selectedMatches.map((tool) => tool.name));
              onChange(names.filter((name) => !removed.has(name)));
            }}
          >
            Clear {scope}
          </Button>
        </span>
      </div>
    </div>
  );
}
