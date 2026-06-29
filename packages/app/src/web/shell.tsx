import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Integration } from "@executor-js/sdk/shared";
import {
  integrationsAtom,
  integrationsOptimisticAtom,
  toolsAllAtom,
} from "@executor-js/react/api/atoms";
import { Button } from "@executor-js/react/components/button";
import { integrationPresetIconUrl } from "@executor-js/react/components/integration-favicon";
import { IntegrationIconWithAccount } from "@executor-js/react/components/integration-icon-with-account";
import { CommandPalette } from "@executor-js/react/components/command-palette";
import { useClientPlugins, useIntegrationPlugins } from "@executor-js/sdk/client";
import { SidebarUpdateCard } from "@executor-js/react/components/update-card";
import { Wordmark } from "@executor-js/react/components/wordmark";
import { ServerConnectionMenu } from "./server-connection-menu";

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
          to="/{-$orgSlug}/plugins/$pluginId/$"
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

// ── IntegrationList ───────────────────────────────────────────────────────────

function IntegrationList(props: { pathname: string; onNavigate?: () => void }) {
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const integrationPlugins = useIntegrationPlugins();

  return AsyncResult.match(integrations, {
    onInitial: () => <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>,
    onFailure: () => (
      <div className="px-2.5 py-2 text-xs text-muted-foreground">No integrations yet</div>
    ),
    onSuccess: ({ value }: { readonly value: readonly Integration[] }) =>
      value.length === 0 ? (
        <div className="px-2.5 py-2 text-sm leading-relaxed text-muted-foreground">
          No integrations yet
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {value.map((integration: Integration) => {
            const slug = String(integration.slug);
            const name = integration.name || slug;
            const detailPath = `/integrations/${slug}`;
            const active =
              props.pathname === detailPath || props.pathname.startsWith(`${detailPath}/`);
            return (
              <Link
                key={slug}
                to="/{-$orgSlug}/integrations/$namespace"
                params={{ namespace: slug }}
                onClick={props.onNavigate}
                className={[
                  "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  active
                    ? "bg-sidebar-active text-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
                ].join(" ")}
              >
                <IntegrationIconWithAccount
                  icon={integrationPresetIconUrl(
                    { id: slug, kind: integration.kind },
                    integrationPlugins,
                  )}
                  sourceId={slug}
                  size="sm"
                />
                <span className="flex-1 truncate">{name}</span>
              </Link>
            );
          })}
        </div>
      ),
  });
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: { pathname: string; onNavigate?: () => void; showBrand?: boolean }) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isPolicies = props.pathname === "/policies";
  const isToolkits = props.pathname === "/toolkits" || props.pathname.startsWith("/toolkits/");

  return (
    <>
      {props.showBrand !== false && (
        <div className="desktop-macos-titlebar flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
          <Link to="/{-$orgSlug}" className="desktop-macos-no-drag flex shrink-0 items-center">
            <Wordmark />
          </Link>
          <div className="desktop-macos-no-drag ml-auto flex min-w-0 flex-1 justify-end pl-3">
            <ServerConnectionMenu variant="header" />
          </div>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <NavItem
          to="/{-$orgSlug}"
          label="Integrations"
          active={isHome}
          onNavigate={props.onNavigate}
        />
        <NavItem
          to="/{-$orgSlug}/secrets"
          label="Secrets"
          active={isSecrets}
          onNavigate={props.onNavigate}
        />
        <NavItem
          to="/{-$orgSlug}/policies"
          label="Policies"
          active={isPolicies}
          onNavigate={props.onNavigate}
        />
        <NavItem
          to="/{-$orgSlug}/toolkits"
          label="Toolkits"
          active={isToolkits}
          onNavigate={props.onNavigate}
        />

        <PluginNav pathname={props.pathname} onNavigate={props.onNavigate} />

        {/* Sources list */}
        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Integrations</span>
        </div>

        <IntegrationList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      <SidebarUpdateCard />

      {/* Footer */}
      <div className="shrink-0 border-t border-sidebar-border px-4 py-2.5">
        <div className="flex flex-col gap-1.5 text-xs leading-none">
          <a
            href="https://executor.sh/docs"
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Docs
          </a>
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
  const refreshSources = useAtomRefresh(integrationsAtom);
  const refreshTools = useAtomRefresh(toolsAllAtom);
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
      <aside className="desktop-macos-sidebar hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent pathname={pathname} />
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
            <div className="desktop-macos-titlebar flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
              <Link to="/{-$orgSlug}" className="desktop-macos-no-drag flex items-center">
                <Wordmark />
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
                className="desktop-macos-no-drag text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground"
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
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="relative flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        {/* Desktop (macOS frameless) draggable title-bar strip. Gives the main
            area the same native window drag + double-click-to-zoom as the
            sidebar header; hidden everywhere else via CSS. Overlays the top of
            the main area (behind page content) so page headers stay flush with
            the top and their borders line up with the sidebar header. */}
        <div className="desktop-macos-main-titlebar" />

        {/* Mobile top bar. The desktop-macos-titlebar offset keeps the
            far-left hamburger clear of the native traffic lights when the macOS
            window is forced below the md breakpoint (issue #1125). */}
        <div className="desktop-macos-titlebar flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
            className="desktop-macos-no-drag bg-card hover:bg-accent/50"
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
          <Link to="/{-$orgSlug}" className="desktop-macos-no-drag flex items-center">
            <Wordmark />
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
      </main>
    </div>
  );
}
