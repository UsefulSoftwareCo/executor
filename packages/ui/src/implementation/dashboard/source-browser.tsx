import { Skeleton } from "../components/skeleton.tsx";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";
import type {
  SourceDisplayEntries,
  SourceDisplayFile,
} from "@executor-js/app-management/contracts/source-display";
import { Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  FileBracesIcon,
  FileCodeIcon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { Code } from "./code.tsx";
import { QueryResult, useQuery } from "./context.tsx";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { cn } from "../lib/utils.ts";

type FileNode = { readonly kind: "file"; readonly name: string; readonly path: string };
type FolderNode = {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: readonly SourceNode[];
};
type SourceNode = FileNode | FolderNode;

function sourceTree(
  files: ReadonlyArray<{ readonly path: string }>,
  prefix = "",
): readonly SourceNode[] {
  const folders = new Set<string>();
  const nodes: SourceNode[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const name = file.path.slice(prefix.length);
    const separator = name.indexOf("/");
    if (separator === -1) nodes.push({ kind: "file", name, path: file.path });
    else folders.add(name.slice(0, separator));
  }
  for (const name of folders) {
    const path = `${prefix}${name}/`;
    nodes.push({ kind: "folder", name, path, children: sourceTree(files, path) });
  }
  return nodes.sort(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name),
  );
}

function SourceTree({
  nodes,
  selected,
  onSelect,
}: {
  readonly nodes: readonly SourceNode[];
  readonly selected: string | undefined;
  readonly onSelect: (path: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "folder" ? (
            <SourceFolder node={node} selected={selected} onSelect={onSelect} />
          ) : (
            <button
              type="button"
              aria-pressed={selected === node.path}
              title={node.path}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-ring",
                selected === node.path && "bg-muted font-medium text-foreground",
              )}
              onClick={() => onSelect(node.path)}
            >
              <HugeiconsIcon
                icon={node.path.endsWith(".json") ? FileBracesIcon : FileCodeIcon}
                size={15}
                strokeWidth={1.7}
                className="shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{node.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SourceFolder({
  node,
  selected,
  onSelect,
}: {
  readonly node: FolderNode;
  readonly selected: string | undefined;
  readonly onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-ring"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={12}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <HugeiconsIcon
          icon={Folder01Icon}
          size={15}
          strokeWidth={1.7}
          className="shrink-0"
          aria-hidden
        />
        <span className="truncate">{node.name}</span>
      </button>
      {open && (
        <div className="ml-3 border-l border-border/60 pl-2">
          <SourceTree nodes={node.children} selected={selected} onSelect={onSelect} />
        </div>
      )}
    </>
  );
}

/** Reads a listed file whose contents the display listing did not inline. */
export type SourceFileQuery<E> = (path: string) => Query<SourceDisplayFile, E>;

/** Inspect server-prepared display files; selection, line counts and copying use that same text. */
export function SourceBrowser<E>({
  files,
  file: readFile,
  Failure,
  className,
}: {
  readonly files: typeof SourceDisplayEntries.Type;
  readonly file: SourceFileQuery<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly className?: string;
}) {
  const [selected, setSelected] = useState("index.ts");
  const file = files.find((file) => file.path === selected) ?? files[0];
  const tree = useMemo(() => sourceTree(files), [files]);
  const picker = (
    <Select value={file.path} onValueChange={setSelected}>
      <SelectTrigger
        aria-label="Source file"
        className="max-w-full border-0 bg-transparent px-0 shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {files.map((file) => (
          <SelectItem key={file.path} value={file.path}>
            {file.path}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <SourceFrame aria-label="Source browser" className={className}>
      <nav
        aria-label="Source files"
        className="flex min-h-0 flex-col border-r bg-muted/15 max-md:hidden"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4 text-xs font-medium">
          Files
          <span className="font-normal tabular-nums text-muted-foreground">{files.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <SourceTree nodes={tree} selected={file.path} onSelect={setSelected} />
        </div>
      </nav>
      {file.content === undefined ? (
        <RemoteSourceFile
          key={file.path}
          path={file.path}
          query={readFile(file.path)}
          Failure={Failure}
          picker={picker}
        />
      ) : (
        <SourceFilePane path={file.path} content={file.content} picker={picker}>
          <Code code={file.content} path={file.path} copyable copyLabel="Copy source" />
        </SourceFilePane>
      )}
    </SourceFrame>
  );
}

/** Load a large file only when it is selected; the header and file picker stay in place. */
function RemoteSourceFile<E>({
  path,
  query,
  Failure,
  picker,
}: {
  readonly path: string;
  readonly query: Query<SourceDisplayFile, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly picker: ReactNode;
}) {
  const { result, refresh } = useQuery(query);
  return (
    <SourceFilePane
      path={path}
      content={Option.getOrUndefined(AsyncResult.value(result))?.content}
      picker={picker}
    >
      <QueryResult
        result={result}
        Failure={(props) => (
          <div className="p-4">
            <Failure {...props} />
          </div>
        )}
        retry={refresh}
        pending={<SourceCodeLoading label={`Loading ${path}`} />}
      >
        {(file) => <Code code={file.content} path={file.path} copyable copyLabel="Copy source" />}
      </QueryResult>
    </SourceFilePane>
  );
}

function SourceFilePane({
  path,
  content,
  picker,
  children,
}: {
  readonly path: string;
  /** Absent while the selected file is loading. */
  readonly content: string | undefined;
  readonly picker: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="source-file flex min-h-0 min-w-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b px-4 max-md:px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs max-md:hidden" title={path}>
          {path}
        </span>
        <div className="min-w-0 flex-1 md:hidden">{picker}</div>
        {content === undefined ? (
          <Skeleton className="h-3 w-12 max-md:hidden" />
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground max-md:hidden">
            {content.split("\n").length} lines
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto [&_.code-view]:min-h-full [&_.code-view]:bg-transparent [&_.code-view]:py-4 [&_.code-view]:text-xs [&_.code-view]:leading-6">
        {children}
      </div>
    </div>
  );
}

/** Use the same file-pane columns and scrolling frame for loaded source and placeholders. */
function SourceFrame({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={cn(
        "grid h-[min(64vh,720px)] min-h-96 grid-cols-[var(--source-sidebar-width,220px)_minmax(0,1fr)] overflow-hidden rounded-lg border bg-background max-md:grid-cols-1",
        className,
      )}
    />
  );
}

/** Match the file tree, file selector, and code viewport while a source read is pending. */
export function SourceBrowserLoading({ className }: { readonly className?: string }) {
  return (
    <SourceFrame role="status" aria-label="Loading files" className={className}>
      <div aria-hidden className="flex min-h-0 flex-col border-r bg-muted/15 max-md:hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4 text-xs font-medium">
          Files
          <Skeleton className="h-3 w-4" />
        </div>
        <div className="space-y-1 p-2">
          {[24, 32, 20].map((width) => (
            <div key={width} className="flex h-8 items-center gap-2 px-2">
              <Skeleton className="size-3 shrink-0" />
              <Skeleton
                className={`h-3 ${width === 24 ? "w-24" : width === 32 ? "w-32" : "w-20"}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden className="flex min-h-0 min-w-0 flex-col">
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b px-4 max-md:px-3">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-12 max-md:hidden" />
        </div>
        <SourceCodeLines />
      </div>
      <span className="sr-only">Loading files…</span>
    </SourceFrame>
  );
}

function SourceCodeLines() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
      {["w-3/5", "w-1/3", "w-4/5", "w-2/5", "w-3/4", "w-1/2"].map((width, index) => (
        <div key={width} className="flex h-6 items-center gap-4">
          <Skeleton className="h-2.5 w-3 shrink-0" />
          <Skeleton className={cn("h-2.5", width, index === 1 && "opacity-0")} />
        </div>
      ))}
    </div>
  );
}

/** Match the code viewport while one selected file is read. */
function SourceCodeLoading({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="flex h-full flex-col">
      <SourceCodeLines />
      <span className="sr-only">{label}…</span>
    </div>
  );
}
