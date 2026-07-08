import type {
  AppSourceRecord,
  CustomToolsDirectoryListing,
  SyncSourceResult,
} from "./custom-tools-client";
import {
  formatDiagnostics,
  formatSyncErrors,
  syncStatusLabel,
  toolDiff,
} from "./custom-tools-client";

export interface SourcePanelModel {
  readonly title: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly status: string;
  readonly tools: readonly string[];
}

export interface SyncNoticeModel {
  readonly status: SyncSourceResult["status"];
  readonly message: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: readonly string[];
  readonly sourceRef?: string;
}

export type DirectoryBrowserRow =
  | { readonly kind: "parent"; readonly name: ".."; readonly path: string }
  | {
      readonly kind: "dir";
      readonly name: string;
      readonly path: string;
      readonly isSymlink: boolean;
    };

const shortRef = (ref: string | undefined): string => (ref ? ref.slice(0, 12) : "Not synced");

export const formatRelativeSyncTime = (timestamp: number, now = Date.now()): string => {
  const diffMs = Math.max(0, now - timestamp);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

export const toolsCountLabel = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

export const sourcePanelModel = (
  source: AppSourceRecord,
  options?: { readonly now?: number },
): SourcePanelModel => {
  const tools =
    source.status.type === "published" || source.status.type === "up-to-date"
      ? source.status.tools
      : [];
  const sourceLabel = source.config.kind === "git" ? source.config.url : source.config.path;
  const pin = source.config.kind === "git" && source.config.ref ? ` @ ${source.config.ref}` : "";
  const status =
    source.status.type === "pending"
      ? "Pending sync"
      : source.status.type === "failed"
        ? `Failed ${formatRelativeSyncTime(source.status.at, options?.now)}`
        : `${source.status.type === "published" ? "Published" : "Up to date"} ${formatRelativeSyncTime(
            source.status.at,
            options?.now,
          )}`;
  return {
    title: source.app,
    source: `${source.kind === "git" ? "Git repository" : "Local directory"}: ${sourceLabel}${pin}`,
    sourceRef: shortRef(source.sourceRef),
    status,
    tools,
  };
};

export const sourceFailureLines = (source: AppSourceRecord): readonly string[] =>
  source.status.type === "failed" ? formatDiagnostics(source.status.errors) : [];

export const syncNoticeFromResult = (
  result: SyncSourceResult,
  beforeTools: readonly string[],
): SyncNoticeModel => {
  const diff =
    result.status === "failed" ? { added: [], removed: [] } : toolDiff(beforeTools, result.tools);
  return {
    status: result.status,
    message: syncStatusLabel(result),
    added: diff.added,
    removed: diff.removed,
    errors: formatSyncErrors(result),
    ...(result.sourceRef ? { sourceRef: result.sourceRef.slice(0, 12) } : {}),
  };
};

export const directoryBrowserRows = (
  listing: CustomToolsDirectoryListing,
): readonly DirectoryBrowserRow[] => [
  ...(listing.parent
    ? [{ kind: "parent" as const, name: ".." as const, path: listing.parent }]
    : []),
  ...listing.dirs.map((dir) => ({
    kind: "dir" as const,
    name: dir.name,
    path: dir.path,
    isSymlink: dir.isSymlink,
  })),
];
