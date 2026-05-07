import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
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
import { AUTH_PATHS } from "../auth/api";
import { useAuth } from "./auth";
import { useOrgRoute } from "./org-route";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "./components/create-organization-form";

// ── ShellSkeleton ────────────────────────────────────────────────────────

export function ShellSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar skeleton */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Skeleton className="h-4 w-20" />
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <div className="mt-5 mb-2 px-2.5">
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="flex flex-col gap-1">
            <Skeleton className="h-7 w-11/12 rounded-md" />
            <Skeleton className="h-7 w-10/12 rounded-md" />
            <Skeleton className="h-7 w-9/12 rounded-md" />
          </div>
        </nav>
        <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
      </aside>

      {/* Main content skeleton */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-4 w-20" />
          <div className="w-7 shrink-0" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

// ── NavItem styling ──────────────────────────────────────────────────────
//
// Sidebar links share active/inactive styling but each call site uses a
// statically-known route template — keep the className helper here and let
// the call site own the typed `<Link>`.

const navItemClassName = (active: boolean) =>
  [
    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
    active
      ? "bg-sidebar-active text-foreground font-medium"
      : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
  ].join(" ");

// ── SourceList ───────────────────────────────────────────────────────────

function SourceList(props: { pathname: string; onNavigate?: () => void }) {
  const { orgHandle } = useOrgRoute();
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
            const detailPath = `/${orgHandle}/sources/${s.id}`;
            const active =
              props.pathname === detailPath || props.pathname.startsWith(`${detailPath}/`);
            return (
              <Link
                key={s.id}
                to="/$org/sources/$namespace"
                params={{ org: orgHandle, namespace: s.id }}
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
  const auth = useAuth();

  if (auth.status !== "authenticated") {
    return <DropdownMenuItem disabled>Loading…</DropdownMenuItem>;
  }
  if (auth.organizations.length === 0) {
    return <DropdownMenuItem disabled>No organizations</DropdownMenuItem>;
  }
  return (
    <>
      {auth.organizations.map((organization) => {
        const isActive = organization.id === props.activeOrganizationId;
        return (
          <DropdownMenuItem key={organization.id} disabled={isActive} className="text-xs" asChild>
            <Link
              to="/$org"
              params={{ org: organization.handle }}
              className="flex w-full items-center gap-2"
            >
              <span className="min-w-0 flex-1 truncate">{organization.name}</span>
              {isActive && <CheckIcon />}
            </Link>
          </DropdownMenuItem>
        );
      })}
    </>
  );
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
  const orgRoute = useOrgRoute();
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);

  const suggestedOrganizationName =
    auth.status === "authenticated" && auth.user.name?.trim() !== "" && auth.user.name != null
      ? `${auth.user.name}'s Organization`
      : "New Organization";

  const form = useCreateOrganizationForm({
    defaultName: suggestedOrganizationName,
    // The form returns the new org's handle on success — navigate via the URL
    // by reloading at the new handle. Once we wire useNavigate in here we can
    // do a soft navigation instead.
    onSuccess: (org) => {
      // Navigate to the new org's URL — the URL is the source of truth for
      // active org now, so a hard reload at the new handle re-renders the
      // shell with the right context.
      window.location.href = `/${org.handle}`;
    },
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
                <p className="truncate text-xs text-muted-foreground">{orgRoute.orgName}</p>
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
                <span className="min-w-0 flex-1 truncate">{orgRoute.orgName}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <OrganizationSwitcherItems activeOrganizationId={orgRoute.orgId} />
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

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: { pathname: string; onNavigate?: () => void; showBrand?: boolean }) {
  const { orgHandle } = useOrgRoute();
  const orgPrefix = `/${orgHandle}`;
  const params = { org: orgHandle };
  const isHome = props.pathname === orgPrefix || props.pathname === `${orgPrefix}/`;
  const isSecrets = props.pathname === `${orgPrefix}/secrets`;
  const isConnections = props.pathname === `${orgPrefix}/connections`;
  const isPolicies = props.pathname === `${orgPrefix}/policies`;
  const isBilling =
    props.pathname === `${orgPrefix}/-/billing` ||
    props.pathname.startsWith(`${orgPrefix}/-/billing/`);
  const isOrg = props.pathname === `${orgPrefix}/-/settings`;

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/$org" params={params} className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <Link
          to="/$org"
          params={params}
          onClick={props.onNavigate}
          className={navItemClassName(isHome)}
        >
          Sources
        </Link>
        <Link
          to="/$org/connections"
          params={params}
          onClick={props.onNavigate}
          className={navItemClassName(isConnections)}
        >
          Connections
        </Link>
        <Link
          to="/$org/secrets"
          params={params}
          onClick={props.onNavigate}
          className={navItemClassName(isSecrets)}
        >
          Secrets
        </Link>
        <Link
          to="/$org/policies"
          params={params}
          onClick={props.onNavigate}
          className={navItemClassName(isPolicies)}
        >
          Policies
        </Link>
        <Link
          to="/$org/-/settings"
          params={params}
          onClick={props.onNavigate}
          className={navItemClassName(isOrg)}
        >
          Organization
        </Link>
        <Link
          to="/$org/-/billing"
          params={params}
          onClick={props.onNavigate}
          className={navItemClassName(isBilling)}
        >
          Billing
        </Link>

        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Sources</span>
        </div>

        <SourceList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      <UserFooter />
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const { orgHandle } = useOrgRoute();
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
              <Link to="/$org" params={{ org: orgHandle }} className="flex items-center gap-1.5">
                <span className="font-display text-base tracking-tight text-foreground">
                  executor
                </span>
              </Link>
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
          <Link to="/$org" params={{ org: orgHandle }} className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
      </main>
    </div>
  );
}
