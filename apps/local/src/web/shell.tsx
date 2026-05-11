import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { sourcesAtom, sourcesOptimisticAtom, toolsAtom } from "@executor-js/react/api/atoms";
import { useScope, useScopeInfo } from "@executor-js/react/api/scope-context";
import { Button } from "@executor-js/react/components/button";
import { SourceFavicon } from "@executor-js/react/components/source-favicon";
import { CommandPalette } from "@executor-js/react/components/command-palette";
import { useClientPlugins } from "@executor-js/sdk/client";

// ── Env ─────────────────────────────────────────────────────────────────

type AppMetaEnv = {
  readonly VITE_APP_VERSION: string;
  readonly VITE_GITHUB_URL: string;
};

const { VITE_APP_VERSION, VITE_GITHUB_URL } = (
  import.meta as ImportMeta & {
    readonly env: AppMetaEnv;
  }
).env;

// ── Version helpers ─────────────────────────────────────────────────────

type UpdateChannel = "latest" | "beta";

const EXECUTOR_DIST_TAGS_PATH = "/v1/app/npm/dist-tags";

type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number> | null;
};

const semverPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const resolveUpdateChannel = (version: string): UpdateChannel =>
  version.includes("-beta.") ? "beta" : "latest";

const parseVersion = (version: string): ParsedVersion | null => {
  const match = version.trim().match(semverPattern);
  if (!match?.groups) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease
      ? match.groups.prerelease.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : null,
  };
};

const comparePrereleaseIdentifiers = (
  left: ReadonlyArray<string | number> | null,
  right: ReadonlyArray<string | number> | null,
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1;
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l < r ? -1 : 1;
  }
  return 0;
};

const compareVersions = (left: string, right: string): number | null => {
  const lv = parseVersion(left);
  const rv = parseVersion(right);
  if (!lv || !rv) return null;
  if (lv.major !== rv.major) return lv.major < rv.major ? -1 : 1;
  if (lv.minor !== rv.minor) return lv.minor < rv.minor ? -1 : 1;
  if (lv.patch !== rv.patch) return lv.patch < rv.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(lv.prerelease, rv.prerelease);
};

// ── useLatestVersion ────────────────────────────────────────────────────

function useLatestVersion(currentVersion: string) {
  const channel = resolveUpdateChannel(currentVersion);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Effect.runPromiseExit(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(EXECUTOR_DIST_TAGS_PATH);
          if (!res.ok) return null;
          return (await res.json()) as Partial<Record<UpdateChannel, string>>;
        },
        catch: (cause) => cause,
      }),
    ).then((exit) => {
      if (!cancelled && Exit.isSuccess(exit)) {
        setLatestVersion(exit.value?.[channel] ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const updateAvailable =
    latestVersion !== null && compareVersions(currentVersion, latestVersion) === -1;

  return { latestVersion, updateAvailable, channel };
}

// ── UpdateCard ──────────────────────────────────────────────────────────

function UpdateCard(props: { latestVersion: string; channel: UpdateChannel }) {
  const command = `npm i -g executor@${props.channel}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
            <path
              d="M8 3v7M5 7l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Update available</p>
          <p className="text-sm text-muted-foreground">v{props.latestVersion}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={handleCopy}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-left hover:bg-background/80"
      >
        <code className="truncate font-mono text-xs text-sidebar-foreground">{command}</code>
        <span className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
              <path
                d="M3 8.5l3.5 3.5L13 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <rect
                x="5"
                y="5"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M3 11V3.5A.5.5 0 013.5 3H11"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
      </Button>
    </div>
  );
}

// ── NavItem ──────────────────────────────────────────────────────────────

function NavItem(props: { to: string; label: string; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={props.to}
      onClick={props.onNavigate}
      className={[
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        props.active
          ? "bg-sidebar-active text-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      ].join(" ")}
    >
      {props.label}
    </Link>
  );
}

// ── PluginNav ────────────────────────────────────────────────────────────
//
// Renders one nav link per plugin page that opted in via
// `pages[].nav.label`. The catch-all `/plugins/$pluginId/$` route is the
// mount point; the splat is the page's relative path with the leading
// slash stripped.

function PluginNav(props: { pathname: string; onNavigate?: () => void }) {
  const plugins = useClientPlugins();
  const entries = plugins.flatMap((plugin) =>
    (plugin.pages ?? [])
      .filter((page) => page.nav)
      .map((page) => {
        const splat = page.path.replace(/^\//, "");
        const href = `/plugins/${plugin.id}${splat ? `/${splat}` : "/"}`;
        return {
          key: `${plugin.id}:${page.path}`,
          pluginId: plugin.id,
          splat,
          href,
          label: page.nav!.label,
        };
      }),
  );
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry) => (
        <Link
          key={entry.key}
          to="/plugins/$pluginId/$"
          params={{ pluginId: entry.pluginId, _splat: entry.splat }}
          onClick={props.onNavigate}
          className={[
            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
            props.pathname === entry.href || props.pathname.startsWith(`${entry.href}/`)
              ? "bg-sidebar-active text-foreground font-medium"
              : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
          ].join(" ")}
        >
          {entry.label}
        </Link>
      ))}
    </>
  );
}

// ── SourceList ───────────────────────────────────────────────────────────

function SourceList(props: { pathname: string; onNavigate?: () => void }) {
  const scopeId = useScope();
  const sources = useAtomValue(sourcesOptimisticAtom(scopeId));

  return AsyncResult.match(sources, {
    onInitial: () => <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>,
    onFailure: () => (
      <div className="px-2.5 py-2 text-xs text-muted-foreground">No sources yet</div>
    ),
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <div className="px-2.5 py-2 text-sm leading-relaxed text-muted-foreground">
          No sources yet
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {value.map((s) => {
            const detailPath = `/sources/${s.id}`;
            const active =
              props.pathname === detailPath || props.pathname.startsWith(`${detailPath}/`);
            return (
              <Link
                key={s.id}
                to="/sources/$namespace"
                params={{ namespace: s.id }}
                onClick={props.onNavigate}
                className={[
                  "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  active
                    ? "bg-sidebar-active text-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
                ].join(" ")}
              >
                <SourceFavicon sourceId={s.id} url={s.url} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="rounded bg-secondary/50 px-1 py-px text-xs font-medium text-muted-foreground">
                  {s.kind}
                </span>
              </Link>
            );
          })}
        </div>
      ),
  });
}

// ── ScopeLabel ───────────────────────────────────────────────────────────

function ScopeLabel() {
  const { name } = useScopeInfo();
  // Show just the last folder name, with full path as tooltip
  const parts = name.replace(/[/\\]+$/, "").split(/[/\\]/);
  const folder = parts[parts.length - 1] || name;

  return (
    <div className="mb-1.5 flex items-center gap-1.5 rounded-md px-2.5 py-1.5" title={name}>
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5 shrink-0 text-muted-foreground">
        <path
          d="M2 4.5C2 3.67 2.67 3 3.5 3h3.09a1 1 0 0 1 .7.29l1.42 1.42a1 1 0 0 0 .7.29H12.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"
          stroke="currentColor"
          strokeWidth="1.2"
        />
      </svg>
      <span className="truncate text-xs font-medium text-foreground/80">{folder}</span>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: {
  pathname: string;
  onNavigate?: () => void;
  showBrand?: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  channel: UpdateChannel;
}) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isConnections = props.pathname === "/connections";
  const isPolicies = props.pathname === "/policies";

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <ScopeLabel />
        <NavItem to="/" label="Sources" active={isHome} onNavigate={props.onNavigate} />
        <NavItem
          to="/connections"
          label="Connections"
          active={isConnections}
          onNavigate={props.onNavigate}
        />
        <NavItem to="/secrets" label="Secrets" active={isSecrets} onNavigate={props.onNavigate} />
        <NavItem
          to="/policies"
          label="Policies"
          active={isPolicies}
          onNavigate={props.onNavigate}
        />

        <PluginNav pathname={props.pathname} onNavigate={props.onNavigate} />

        {/* Sources list */}
        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Sources</span>
        </div>

        <SourceList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      {props.updateAvailable && props.latestVersion && (
        <UpdateCard latestVersion={props.latestVersion} channel={props.channel} />
      )}

      {/* Footer */}
      <div className="shrink-0 border-t border-sidebar-border px-4 py-2.5">
        <div className="flex flex-col gap-1.5 text-xs leading-none">
          <a
            href={`${VITE_GITHUB_URL}/issues`}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Feedback / bug?
          </a>
          <a
            href={VITE_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Star on GitHub
          </a>
          <span className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            v{VITE_APP_VERSION}
          </span>
        </div>
      </div>
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;
  const scopeId = useScope();
  const refreshSources = useAtomRefresh(sourcesAtom(scopeId));
  const refreshTools = useAtomRefresh(toolsAtom(scopeId));
  const { latestVersion, updateAvailable, channel } = useLatestVersion(VITE_APP_VERSION);
  const lastPathname = useRef(pathname);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  if (lastPathname.current !== pathname) {
    lastPathname.current = pathname;
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }

  // Lock scroll when mobile sidebar open
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileSidebarOpen]);

  useEffect(() => {
    if (!import.meta.hot) {
      return;
    }

    const refreshBackendData = () => {
      refreshSources();
      refreshTools();
    };

    import.meta.hot.on("executor:backend-updated", refreshBackendData);

    return () => {
      import.meta.hot?.off("executor:backend-updated", refreshBackendData);
    };
  }, [refreshSources, refreshTools]);

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette />
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent
          pathname={pathname}
          updateAvailable={updateAvailable}
          latestVersion={latestVersion}
          channel={channel}
        />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="relative flex h-full w-[84vw] max-w-xs flex-col border-r border-sidebar-border bg-sidebar shadow-2xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
              <Link to="/" className="flex items-center gap-1.5">
                <span className="font-display text-base tracking-tight text-foreground">
                  executor
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
                className="text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground"
              >
                <svg viewBox="0 0 16 16" className="size-3.5">
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </Button>
            </div>
            <SidebarContent
              pathname={pathname}
              onNavigate={() => setMobileSidebarOpen(false)}
              showBrand={false}
              updateAvailable={updateAvailable}
              latestVersion={latestVersion}
              channel={channel}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
            className="bg-card hover:bg-accent/50"
          >
            <svg viewBox="0 0 16 16" className="size-4">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </Button>
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
      </main>
    </div>
  );
}
