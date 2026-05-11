import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { sourcesOptimisticAtom } from "@executor-js/react/api/atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { Button } from "@executor-js/react/components/button";
import { Skeleton } from "@executor-js/react/components/skeleton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { SupportOptions } from "./components/support-options";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@executor-js/react/components/dropdown-menu";
import { SourceFavicon } from "@executor-js/react/components/source-favicon";
import { CommandPalette } from "@executor-js/react/components/command-palette";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { AUTH_PATHS } from "../auth/api";
import { organizationsAtom, switchOrganization, useAuth } from "./auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "./components/create-organization-form";

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

// ── SourceList ───────────────────────────────────────────────────────────

function SourceList(props: { pathname: string; onNavigate?: () => void }) {
  const scopeId = useScope();
  const sources = useAtomValue(sourcesOptimisticAtom(scopeId));

  return AsyncResult.match(sources, {
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
                <SourceFavicon url={s.url} />
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

// ── UserFooter ──────────────────────────────────────────────────────────

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

function Avatar(props: {
  url: string | null;
  name: string | null;
  email: string;
  size?: "sm" | "md";
}) {
  const size = props.size === "md" ? "size-8" : "size-7";
  const text = props.size === "md" ? "text-sm" : "text-xs";
  if (props.url) {
    return <img src={props.url} alt="" className={`${size} shrink-0 rounded-full`} />;
  }
  return (
    <div
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-primary/10 ${text} font-semibold text-primary`}
    >
      {initialsFor(props.name, props.email)}
    </div>
  );
}

function OrganizationSwitcherItems(props: { activeOrganizationId: string | null }) {
  const organizations = useAtomValue(organizationsAtom);
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });

  const handleSwitch = async (organizationId: string) => {
    if (organizationId === props.activeOrganizationId) return;
    const exit = await doSwitchOrganization({
      payload: { organizationId },
      reactivityKeys: authWriteKeys,
    });
    if (Exit.isSuccess(exit)) window.location.reload();
  };

  return AsyncResult.match(organizations, {
    onInitial: () => <DropdownMenuItem disabled>Loading…</DropdownMenuItem>,
    onFailure: () => <DropdownMenuItem disabled>Failed to load organizations</DropdownMenuItem>,
    onSuccess: ({ value }) =>
      value.organizations.length === 0 ? (
        <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
      ) : (
        <>
          {value.organizations.map((organization: { id: string; name: string }) => {
            const isActive = organization.id === props.activeOrganizationId;
            return (
              <DropdownMenuItem
                key={organization.id}
                disabled={isActive}
                onClick={() => handleSwitch(organization.id)}
                className="text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                {isActive && <CheckIcon />}
              </DropdownMenuItem>
            );
          })}
        </>
      ),
  });
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="ml-auto size-3 text-muted-foreground">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UserFooter() {
  const auth = useAuth();
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);

  const suggestedOrganizationName =
    auth.status === "authenticated" && auth.user.name?.trim() !== "" && auth.user.name != null
      ? `${auth.user.name}'s Organization`
      : "New Organization";

  const form = useCreateOrganizationForm({
    defaultName: suggestedOrganizationName,
    onSuccess: () => window.location.reload(),
  });

  if (auth.status !== "authenticated") return null;

  const openCreateOrganization = () => {
    form.reset(suggestedOrganizationName);
    setCreateOrganizationOpen(true);
  };

  return (
    <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
      <Dialog
        open={createOrganizationOpen}
        onOpenChange={(open) => {
          setCreateOrganizationOpen(open);
          if (!open) form.reset(suggestedOrganizationName);
        }}
      >
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
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Organization
            </DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {auth.organization?.name ?? "No organization"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <OrganizationSwitcherItems activeOrganizationId={auth.organization?.id ?? null} />
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={(event) => {
                    event.preventDefault();
                    openCreateOrganization();
                  }}
                >
                  Create organization
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="text-xs">
              <Link to="/api-keys">API keys</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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
              onClick={async () => {
                await fetch(AUTH_PATHS.logout, { method: "POST" });
                window.location.href = "/";
              }}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Create organization</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              Add another organization under your current account and switch into it immediately.
            </DialogDescription>
          </DialogHeader>

          <CreateOrganizationFields
            name={form.name}
            onNameChange={(name) => {
              form.setName(name);
              if (form.error) form.setError(null);
            }}
            error={form.error}
            onSubmit={() => void form.submit()}
          />

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={form.creating}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void form.submit()}
              disabled={!form.canSubmit || form.creating}
            >
              {form.creating ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── SupportButton ────────────────────────────────────────────────────────

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.25 6.25c.25-1 1-1.5 1.85-1.5 1 0 1.9.7 1.9 1.7 0 .8-.5 1.2-1.1 1.6-.55.4-.9.7-.9 1.45M8 11.25v.05"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SupportButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-normal text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground"
      >
        <HelpIcon className="size-3.5 text-muted-foreground" />
        Get support
      </Button>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Get support</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Reach out through any of the channels below.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <SupportOptions />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: { pathname: string; onNavigate?: () => void; showBrand?: boolean }) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isConnections = props.pathname === "/connections";
  const isPolicies = props.pathname === "/policies";
  const isBilling = props.pathname === "/billing" || props.pathname.startsWith("/billing/");
  const isOrg = props.pathname === "/org";

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Brand onNavigate={props.onNavigate} />
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
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
        <NavItem to="/org" label="Organization" active={isOrg} onNavigate={props.onNavigate} />
        <NavItem to="/billing" label="Billing" active={isBilling} onNavigate={props.onNavigate} />

        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Sources</span>
        </div>

        <SourceList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      <div className="shrink-0 px-2 pb-2">
        <SupportButton />
      </div>

      <UserFooter />
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;
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

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette />
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
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
