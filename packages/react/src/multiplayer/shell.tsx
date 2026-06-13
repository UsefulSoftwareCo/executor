import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Integration } from "@executor-js/sdk/shared";
import { integrationsOptimisticAtom } from "../api/atoms";
import { Button } from "../components/button";
import { Skeleton } from "../components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import {
  IntegrationFavicon,
  integrationInferredUrl,
  integrationPresetIconUrl,
} from "../components/integration-favicon";
import { CommandPalette } from "../components/command-palette";
import { useIntegrationPlugins } from "@executor-js/sdk/client";
import { useAuth } from "./auth-context";

// ---------------------------------------------------------------------------
// Shared multiplayer shell (cloud + self-host).
//
// Provider-neutral: identity comes from the shared `useAuth()` seam. The bits
// that genuinely differ per product are injected:
//   - `onSignOut`     how the session is ended (WorkOS logout vs Better Auth)
//   - `orgMenuSlot`   org switcher / create-org (cloud only)
//   - `supportSlot`   support dialog button (cloud only)
//   - `navItems`      which sections show (e.g. cloud adds Billing)
// Everything visual is identical so both products look the same.
// ---------------------------------------------------------------------------

export type ShellNavItem = { readonly to: string; readonly label: string };

/** Integrations lives at "/", plus the standard tool-management sections. Hosts
 *  spread this and append their own (e.g. Organization, Billing). */
export const defaultShellNavItems: ReadonlyArray<ShellNavItem> = [
  { to: "/", label: "Integrations" },
  { to: "/secrets", label: "Providers" },
  { to: "/policies", label: "Policies" },
];

export interface ShellProps {
  /** End the session. Cloud POSTs its logout path; self-host calls Better Auth. */
  readonly onSignOut: () => void | Promise<void>;
  /** Nav sections; defaults to {@link defaultShellNavItems}. */
  readonly navItems?: ReadonlyArray<ShellNavItem>;
  /** Where the "API keys" footer link goes; null hides it. Default "/api-keys". */
  readonly apiKeysTo?: string | null;
  /** Injected into the account dropdown — cloud's org switcher / create-org. */
  readonly orgMenuSlot?: ReactNode;
  /** Injected support button above the account footer (cloud). */
  readonly supportSlot?: ReactNode;
}

// ── Brand ────────────────────────────────────────────────────────────────

function Brand(props: { onNavigate?: () => void }) {
  return (
    <Link to="/" onClick={props.onNavigate} className="flex items-center gap-1.5">
      <span className="font-display text-base tracking-tight text-foreground">executor</span>
      <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        Beta
      </span>
    </Link>
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

// ── IntegrationList ───────────────────────────────────────────────────────────

function IntegrationList(props: { pathname: string; onNavigate?: () => void }) {
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const integrationPlugins = useIntegrationPlugins();

  return AsyncResult.match(integrations, {
    onInitial: () => (
      <div className="flex flex-col gap-1 px-2.5 py-1">
        {[80, 65, 72, 58, 68].map((w, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md py-1.5">
            <Skeleton className="size-3.5 shrink-0 rounded" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    ),
    onFailure: () => (
      <div className="px-2.5 py-2 text-xs text-muted-foreground">No integrations yet</div>
    ),
    onSuccess: ({ value }) =>
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
                to="/integrations/$namespace"
                params={{ namespace: slug }}
                onClick={props.onNavigate}
                className={[
                  "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  active
                    ? "bg-sidebar-active text-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
                ].join(" ")}
              >
                <IntegrationFavicon
                  icon={integrationPresetIconUrl(
                    { id: slug, kind: integration.kind, name, url: integration.displayUrl },
                    integrationPlugins,
                  )}
                  url={
                    integration.displayUrl ??
                    integrationInferredUrl({ id: slug, name }) ??
                    undefined
                  }
                />
                <span className="flex-1 truncate">{name}</span>
              </Link>
            );
          })}
        </div>
      ),
  });
}

// ── Avatar / initials ──────────────────────────────────────────────────────

function initialsFor(name: string | null, email: string) {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return email[0]!.toUpperCase();
}

function Avatar(props: { url: string | null; name: string | null; email: string }) {
  if (props.url) {
    return <img src={props.url} alt="" className="size-7 shrink-0 rounded-full" />;
  }
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {initialsFor(props.name, props.email)}
    </div>
  );
}

// ── UserFooter ──────────────────────────────────────────────────────────

function UserFooter(props: Pick<ShellProps, "onSignOut" | "apiKeysTo" | "orgMenuSlot">) {
  const auth = useAuth();
  if (auth.status !== "authenticated") return null;
  const apiKeysTo = props.apiKeysTo === undefined ? "/api-keys" : props.apiKeysTo;

  return (
    <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-1 py-1 text-left hover:bg-sidebar-active/60"
          >
            <Avatar url={auth.user.avatarUrl} name={auth.user.name} email={auth.user.email} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                {auth.user.name ?? auth.user.email}
              </p>
              {auth.organization && (
                <p className="truncate text-xs text-muted-foreground">{auth.organization.name}</p>
              )}
            </div>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="size-3.5 shrink-0 text-muted-foreground"
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          {props.orgMenuSlot}
          {apiKeysTo && (
            <>
              <DropdownMenuItem asChild className="text-xs">
                <Link to={apiKeysTo}>API keys</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Signed in as
          </DropdownMenuLabel>
          <DropdownMenuItem disabled className="gap-2 text-xs opacity-100">
            <Avatar url={auth.user.avatarUrl} name={auth.user.name} email={auth.user.email} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">
                {auth.user.name ?? auth.user.email}
              </p>
              {auth.user.name && (
                <p className="truncate text-muted-foreground">{auth.user.email}</p>
              )}
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs text-destructive focus:text-destructive"
            onClick={() => void props.onSignOut()}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(
  props: ShellProps & { pathname: string; onNavigate?: () => void; showBrand?: boolean },
) {
  const navItems = props.navItems ?? defaultShellNavItems;
  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Brand onNavigate={props.onNavigate} />
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        {navItems.map((item) => (
          <NavItem
            key={item.to}
            to={item.to}
            label={item.label}
            active={item.to === "/" ? props.pathname === "/" : props.pathname.startsWith(item.to)}
            onNavigate={props.onNavigate}
          />
        ))}

        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Integrations</span>
        </div>

        <IntegrationList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      {props.supportSlot && <div className="shrink-0 px-2 pb-2">{props.supportSlot}</div>}

      <UserFooter
        onSignOut={props.onSignOut}
        apiKeysTo={props.apiKeysTo}
        orgMenuSlot={props.orgMenuSlot}
      />
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell(props: ShellProps) {
  const location = useLocation();
  const pathname = location.pathname;
  const lastPathname = useRef(pathname);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  if (lastPathname.current !== pathname) {
    lastPathname.current = pathname;
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileSidebarOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette />
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent {...props} pathname={pathname} />
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
              <Brand onNavigate={() => setMobileSidebarOpen(false)} />
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
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
              {...props}
              pathname={pathname}
              onNavigate={() => setMobileSidebarOpen(false)}
              showBrand={false}
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
            type="button"
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
          <Brand />
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
      </main>
    </div>
  );
}
