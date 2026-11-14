import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import type { PagedList, PagedListState } from "../../contracts/paging.ts";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Page-level constrained container. Accepts className for overrides. */
export function PageContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`mx-auto max-w-7xl w-full px-6 ${className}`}>{children}</div>;
}

/** Standard page header row — title on left, actions on right. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <PageContainer className="flex items-center gap-4 py-4 shrink-0">
      <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
      {children && <div className="flex items-center gap-3 ml-auto">{children}</div>}
    </PageContainer>
  );
}

/** Collapsible section with a label — used in detail panels. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-white/5">
      <p className="text-sm text-zinc-500 font-medium mb-2">{title}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State placeholders
// ---------------------------------------------------------------------------

export function LoadingState({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex items-center justify-center p-16 text-zinc-500">
      <p className="text-sm">{message}</p>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-zinc-500 gap-2">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-sm text-zinc-600">{description}</p>}
    </div>
  );
}

export function ErrorState({
  message = "Something went wrong",
  detail,
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-zinc-500 gap-3">
      <p className="text-sm font-medium">{message}</p>
      {detail && (
        <pre className="text-sm text-red-400 max-w-2xl overflow-auto whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons & controls
// ---------------------------------------------------------------------------

export function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button
      className="text-sm px-3 py-1 rounded-md border border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/20 bg-transparent cursor-pointer"
      onClick={onRefresh}
    >
      Refresh
    </button>
  );
}

/**
 * Start a paged list again: drop the pages after the first, which stops any of them still
 * loading, and read the first page again.
 */
export function useRestartList(list: PagedList<unknown, unknown>): () => void {
  const refresh = useAtomRefresh(list.first);
  const request = useAtomSet(list.requested);
  return () => {
    request(0);
    refresh();
  };
}

/** Refresh a paged list from its first page. */
export function RefreshListButton({ list }: { list: PagedList<unknown, unknown> }) {
  return <RefreshButton onRefresh={useRestartList(list)} />;
}

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`text-sm px-3 py-1.5 border-none rounded-md cursor-pointer ${
        active
          ? "text-zinc-100 bg-white/10"
          : "text-zinc-400 bg-transparent hover:text-zinc-200 hover:bg-white/5"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`text-sm px-2.5 py-1 border rounded-md cursor-pointer ${
        active
          ? "border-accent-dim/50 text-accent bg-accent/5"
          : "border-white/10 text-zinc-400 bg-transparent hover:text-zinc-200 hover:border-white/20"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="text-sm px-3 py-1.5 border border-white/10 rounded-md bg-transparent text-zinc-200 outline-none w-72 focus:border-accent-dim placeholder:text-zinc-600"
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const SEVERITY_STYLES: Record<string, string> = {
  ERROR: "text-red-400 bg-red-400/10",
  WARN: "text-amber-400 bg-amber-400/10",
  INFO: "text-sky-400 bg-sky-400/10",
  DEBUG: "text-zinc-500 bg-zinc-500/10",
  TRACE: "text-zinc-600 bg-zinc-600/10",
};

export function SeverityBadge({ severity }: { severity: string }) {
  const cls = SEVERITY_STYLES[severity] ?? "text-zinc-500 bg-zinc-500/10";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-sm font-medium ${cls}`}>
      {severity}
    </span>
  );
}

export function StatusBadge({ status, isRunning }: { status: string; isRunning?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-block px-1.5 py-0.5 rounded text-sm font-medium ${
          status === "error" ? "bg-red-400/10 text-red-400" : "bg-emerald-400/10 text-emerald-400"
        }`}
      >
        {status}
      </span>
      {isRunning && <LiveBadge />}
    </div>
  );
}

export function LiveBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded text-sm font-semibold bg-accent/15 text-accent">
      LIVE
    </span>
  );
}

/** Inline service name pill with deterministic color. */
export function ServiceBadge({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="text-sm px-1.5 py-0.5 rounded whitespace-nowrap shrink-0"
      style={{ color, background: `${color}18` }}
    >
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Paged lists
// ---------------------------------------------------------------------------

/** Read a paged list, with the actions its end-of-list control needs. */
export function usePagedList<A, E>(list: PagedList<A, E>) {
  const registry = useContext(RegistryContext);
  const state = useAtomValue(list.state);
  const request = useAtomSet(list.requested);
  // Ask for exactly one page past those shown, so a double click cannot skip ahead.
  const loadMore = () => request(state.extraPages + 1);
  const retry = () => {
    if (state.end.status === "failed") registry.refresh(state.end.page);
  };
  return { state, loadMore, retry };
}

/** A row count that does not pass a page size off as a total: `200+` while more remain. */
export function listCount(state: PagedListState<unknown, unknown>): string {
  const count = state.rows.length.toLocaleString();
  return state.end.status === "complete" ? count : `${count}+`;
}

/**
 * The line under a paged list: how much it shows, and the control that loads the next page.
 *
 * The control stays mounted while a page loads, so keyboard focus stays on it and the next page
 * is one more Enter away. When the last page arrives the control goes, and focus moves to the
 * summary instead of falling to the page. The summary is a live region, so the new count is
 * announced when rows are added.
 */
export function ListEnd<E>({
  noun,
  state,
  onLoadMore,
  onRetry,
}: {
  noun: string;
  state: PagedListState<unknown, E>;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const count = state.rows.length.toLocaleString();
  const window = state.lookback === null ? "" : ` from the last ${state.lookback}`;
  const { end } = state;
  const action = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  // Whether the control had focus when it was last used, so focus can follow the list's end.
  const keepFocus = useRef(false);

  useLayoutEffect(() => {
    if (!keepFocus.current || end.status === "loading") return;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (end.status === "complete") {
      if (lost || document.activeElement === action.current) summary.current?.focus();
    } else if (lost) {
      action.current?.focus();
    }
    keepFocus.current = false;
  }, [end.status]);

  const act = () => {
    if (end.status === "loading") return;
    keepFocus.current = document.activeElement === action.current;
    if (end.status === "failed") onRetry();
    else onLoadMore();
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-t border-white/5 py-3 pl-6 pr-6 text-sm text-zinc-500"
      data-list-end={end.status}
    >
      <p
        ref={summary}
        role="status"
        tabIndex={-1}
        className="rounded outline-offset-4 focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-white/40"
      >
        {end.status === "complete"
          ? `All ${count} ${noun}${window}`
          : `Showing ${count} ${noun}${window}. More are available.`}
      </p>
      {end.status === "failed" && (
        <p className="text-red-400" role="alert">
          Could not load more {noun}: {errorSummary(end.cause)}
        </p>
      )}
      {end.status !== "complete" && (
        <button
          ref={action}
          className={`text-sm px-3 py-1 rounded-md border border-white/10 bg-transparent ${
            end.status === "loading"
              ? "text-zinc-500 cursor-default"
              : "text-zinc-300 hover:text-zinc-100 hover:border-white/20 cursor-pointer"
          }`}
          aria-disabled={end.status === "loading"}
          onClick={act}
        >
          {end.status === "loading"
            ? "Loading…"
            : end.status === "failed"
              ? "Try again"
              : "Load more"}
        </button>
      )}
    </div>
  );
}

/** The first line of a failure, short enough to sit beside the list. */
function errorSummary(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error) return squashed.message;
  return Cause.pretty(cause).split("\n")[0] ?? "unknown error";
}
