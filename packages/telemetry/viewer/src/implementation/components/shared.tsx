import { type ReactNode } from "react";
import { useAtomRefresh } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";

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

export function RefreshButton({ atom }: { atom: Atom.Atom<unknown> }) {
  const refresh = useAtomRefresh(atom);
  return (
    <button
      className="text-sm px-3 py-1 rounded-md border border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/20 bg-transparent cursor-pointer"
      onClick={refresh}
    >
      Refresh
    </button>
  );
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
