import { Skeleton } from "../components/skeleton.tsx";
import type { ComponentProps } from "react";
import { useMemo, useState } from "react";
import type { SourceFiles } from "@executor-js/sdk";
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
import { Code, useFormattedCode } from "./code.tsx";
import { cn } from "../lib/utils.ts";

type FileNode = { readonly kind: "file"; readonly name: string; readonly path: string };
type FolderNode = {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: readonly SourceNode[];
};
type SourceNode = FileNode | FolderNode;

function sourceTree(files: SourceFiles, prefix = ""): readonly SourceNode[] {
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

/** Read-only source inspection, shared by working trees and retained deployments. */
export function SourceBrowser({
  files,
  className,
}: {
  readonly files: SourceFiles;
  readonly className?: string;
}) {
  const [selected, setSelected] = useState("index.ts");
  const file = files.find((file) => file.path === selected) ?? files[0];
  const tree = useMemo(() => sourceTree(files), [files]);
  const display = useFormattedCode(file?.content ?? "", file?.path ?? "");
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
          <SourceTree nodes={tree} selected={file?.path} onSelect={setSelected} />
        </div>
      </nav>
      <div className="source-file flex min-h-0 min-w-0 flex-col">
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-b px-4 max-md:px-3">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs max-md:hidden"
            title={file?.path}
          >
            {file?.path}
          </span>
          <div className="min-w-0 flex-1 md:hidden">
            <Select value={file?.path ?? ""} onValueChange={setSelected}>
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
          </div>
          <span className="text-xs tabular-nums text-muted-foreground max-md:hidden">
            {display.split("\n").length} lines
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto [&_.code-view]:min-h-full [&_.code-view]:bg-transparent [&_.code-view]:py-4 [&_.code-view]:text-xs [&_.code-view]:leading-6">
          {file && <Code code={file.content} path={file.path} copyable copyLabel="Copy source" />}
        </div>
      </div>
    </SourceFrame>
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
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
          {["w-3/5", "w-1/3", "w-4/5", "w-2/5", "w-3/4", "w-1/2"].map((width, index) => (
            <div key={width} className="flex h-6 items-center gap-4">
              <Skeleton className="h-2.5 w-3 shrink-0" />
              <Skeleton className={cn("h-2.5", width, index === 1 && "opacity-0")} />
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading files…</span>
    </SourceFrame>
  );
}
