import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { OrganizationSlug, OrganizationReference } from "@executor-js/hosted-server/organization";
import { organizationTargetAtom } from "../../contracts/organization-reference.ts";
import { AsyncResult } from "effect/unstable/reactivity";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { OrganizationId, OrganizationAccess } from "@executor-js/hosted-server/organization";
import { Link, Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { Cause, Exit, Match, Option, Schema } from "effect";
import { sessionAtom } from "../../contracts/auth.ts";
import { OrganizationResume } from "../../contracts/navigation.ts";
import { readLastOrganization, rememberOrganization, forgetOrganization } from "../session-hint.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { Dialog, DialogContent, DialogTitle } from "@executor-js/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@executor-js/ui/components/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@executor-js/ui/components/avatar";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  accessAtom,
  organizationPresentation,
  createOrganizationAtom,
  organizationsAtom,
  OrganizationFailed,
  type OrganizationSummary,
} from "../../contracts/organization.ts";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Spinner } from "@executor-js/ui/components/spinner";

import { HostedDashboard } from "./dashboard-bindings.tsx";
import { OrganizationSwitcherSkeleton } from "./dashboard-frame.tsx";
import { HostedEntry, DashboardEntryPending, OrganizationLookupError } from "./entry.tsx";

const OrganizationContext = createContext<
  | (OrganizationAccess & {
      readonly name: string;
      readonly slug: string;
      readonly logo: string | null;
      readonly checking: boolean;
    })
  | null
>(null);
const OrganizationRouteContext = createContext<{
  readonly organization: OrganizationReference;
  readonly slug: string;
  readonly role: OrganizationAccess["role"] | undefined;
  readonly id: OrganizationId | undefined;
  readonly name: string | undefined;
  readonly unavailable: boolean;
  readonly metadataFailed: boolean;
  readonly retry: () => void;
} | null>(null);
/** The URL target is immediately usable by page requests, independently of sidebar metadata. */
export function useOrganizationRoute() {
  const value = useContext(OrganizationRouteContext);
  if (value === null) throw new Error("Organization route context is missing");
  return value;
}
/** Show only content errors; keep the dashboard and navigation mounted. */
export function OrganizationContent({ children }: { readonly children: ReactNode }) {
  const route = useOrganizationRoute();
  return route.unavailable ? (
    <section className="p-6">
      <EmptyState
        title="Organization unavailable"
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={route.retry}>Try again</Button>
            <Link className="text-sm underline underline-offset-4" to="/">
              Choose organization
            </Link>
          </div>
        }
      >
        This organization does not exist or you do not have access.
      </EmptyState>
    </section>
  ) : (
    children
  );
}
/** Native organization settings need verified metadata, but their wait stays inside the page. */
export function OrganizationDetailsBoundary({
  children,
  pending,
  title = "Organization settings",
}: {
  readonly children: ReactNode;
  readonly pending: ReactNode;
  readonly title?: string;
}) {
  const organization = useContext(OrganizationContext);
  const route = useOrganizationRoute();
  if (organization === null && route.metadataFailed)
    return (
      <PageFrame>
        <PageHeader title={title} />
        <p role="alert">Unable to load {title.toLowerCase()}.</p>
        <Button variant="outline" onClick={route.retry}>
          Try again
        </Button>
      </PageFrame>
    );
  return organization === null ? pending : children;
}
/** Verified details when available; missing metadata must not hide static page content. */
export function useOrganizationDetails() {
  return useContext(OrganizationContext);
}
/** Settings use verified organization metadata; request handlers still enforce current access. */
export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (value === null) throw new Error("Organization context is missing");
  return value;
}
/** Safe message for membership mutations. */
export function organizationError(cause: Cause.Cause<OrganizationFailed | Schema.SchemaError>) {
  return Option.match(Cause.findErrorOption(cause), {
    onSome: Match.type<OrganizationFailed | Schema.SchemaError>().pipe(
      Match.tagsExhaustive({
        OrganizationFailed: (error) => error.message,
        SchemaError: () => "The server returned an unexpected organization. Reload and try again.",
      }),
    ),
    onNone: () => "Unable to complete this change. Try again.",
  });
}

/** Explicit creation, never an implicitly provisioned global organization. */
export function CreateOrganization({
  onCreated,
  heading = <h2>Create an organization</h2>,
}: {
  readonly onCreated?: (organization: OrganizationSummary) => void | Promise<void>;
  readonly heading?: ReactNode;
}) {
  const create = useAtomSet(createOrganizationAtom, { mode: "promiseExit" });
  const state = useAtomValue(createOrganizationAtom);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="settings-form [&_h2]:text-[15px] [&_h2]:font-medium flex flex-col gap-4 w-full max-w-100 mt-7 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-[13px] [&_>_button]:self-start"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const data = new FormData(event.currentTarget);
        const result = await create({
          name: String(data.get("name")).trim(),
          slug: String(data.get("slug")).trim(),
        });
        if (Exit.isFailure(result)) setError(organizationError(result.cause));
        else await onCreated?.(result.value);
      }}
    >
      {heading}
      <label>
        Name
        <Input name="name" placeholder="Acme" required maxLength={100} disabled={state.waiting} />
      </label>
      <label>
        Handle
        <Input
          name="slug"
          placeholder="acme"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          title="Lowercase letters, numbers, and hyphens"
          maxLength={80}
          disabled={state.waiting}
        />
      </label>
      {error && (
        <p className="auth-error text-destructive text-[13px]" role="alert">
          {error}
        </p>
      )}
      <Button loading={state.waiting}>Create organization</Button>
    </form>
  );
}

/** Shared creation modal. Return keyboard focus to the button that opened it. */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  triggerRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="organization-dialog max-h-[calc(100dvh-32px)] w-[420px] overflow-y-auto rounded-[10px] sm:max-w-[420px] [&_.settings-form]:m-0 [&_.settings-form]:max-w-none [&_.settings-form_h2]:pr-7 [&_.settings-form_h2]:mb-1"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <CreateOrganization
          heading={<DialogTitle>Create organization</DialogTitle>}
          onCreated={async ({ slug }) => {
            onOpenChange(false);
            await navigate({
              to: "/org/$organizationSlug/apps",
              params: { organizationSlug: slug },
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Restore only bare-root visits; explicit organization and consent links keep their own destinations. */
export function OrganizationResumeBoundary({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  if (pathname !== "/" || session === undefined || session === null) return children;
  return (
    <ResumeOrganization key={session.user.id} userId={session.user.id}>
      {children}
    </ResumeOrganization>
  );
}

/** A saved ID is enough to enter; membership and sidebar metadata resolve in the destination. */
function ResumeOrganization({
  userId,
  children,
}: {
  readonly userId: string;
  readonly children: ReactNode;
}) {
  const [organization] = useState(() => readLastOrganization(userId));
  return organization === undefined ? (
    children
  ) : (
    <Navigate
      to="/org/$organizationSlug/apps"
      params={{ organizationSlug: organization }}
      state={{ organizationResume: { organization, reference: organization, userId } }}
      replace
    />
  );
}

/** Keep query keys unchanged when verified aliases identify the same organization. */
function useOrganizationQueryReference(routeReference: OrganizationReference) {
  const [retained, setRetained] = useState(routeReference);
  const retainedTarget = useAtomValue(organizationTargetAtom(retained));
  const routeTarget = useAtomValue(organizationTargetAtom(routeReference));
  const sameOrganization =
    routeReference === retained || (retainedTarget !== undefined && retainedTarget === routeTarget);
  const reference = sameOrganization ? retained : routeReference;
  // A different or unknown destination resets before children render. A canonical
  // URL replacement keeps the existing atoms and their in-flight requests.
  if (reference !== retained) setRetained(reference);
  return reference;
}

/** Start page reads from the URL immediately. Access and organization controls resolve alongside them. */
export function OrganizationBoundary({
  slug,
  children,
}: {
  readonly slug: string;
  readonly children: ReactNode;
}) {
  const reference = useOrganizationQueryReference(
    Schema.decodeUnknownSync(OrganizationReference)(slug),
  );
  const access = useAtomValue(accessAtom(reference));
  const session = useAtomValue(sessionAtom);
  const snapshot = useAtomValue(organizationPresentation(reference));
  const registry = useContext(RegistryContext);
  const target = useAtomValue(organizationTargetAtom(reference));
  const organizations = useAtomValue(organizationsAtom);
  const refreshAccess = useAtomRefresh(accessAtom(reference));
  const refreshOrganizations = useAtomRefresh(organizationsAtom);
  const navigate = useNavigate();
  const location = useLocation();
  const resume = Option.getOrUndefined(
    Schema.decodeUnknownOption(OrganizationResume)(location.state.organizationResume),
  );
  const userId = Option.getOrUndefined(AsyncResult.value(session))?.user.id;
  const unavailable =
    AsyncResult.isFailure(access) &&
    Option.match(Cause.findErrorOption(access.cause), {
      onNone: () => false,
      onSome: (error) =>
        Match.value(error).pipe(
          Match.tag("OrganizationForbidden", "Unauthorized", () => true),
          Match.orElse(() => false),
        ),
    });
  const rejectedResume =
    unavailable &&
    resume !== undefined &&
    resume.userId === userId &&
    ((resume.reference ?? resume.organization) === reference || resume.organization === target);
  useEffect(() => {
    if (!rejectedResume || resume === undefined) return;
    forgetOrganization(resume.userId, resume.organization);
    void navigate({ to: "/", replace: true });
  }, [rejectedResume, resume, navigate]);
  useEffect(() => {
    if (
      !AsyncResult.isSuccess(access) ||
      access.waiting ||
      !AsyncResult.isSuccess(session) ||
      session.waiting ||
      session.value === null
    )
      return;
    const organization = access.value.organization;
    const user = session.value.user.id;
    const remember = () => {
      if (document.visibilityState === "visible" && document.hasFocus())
        rememberOrganization(user, organization);
    };
    remember();
    window.addEventListener("focus", remember);
    document.addEventListener("visibilitychange", remember);
    return () => {
      window.removeEventListener("focus", remember);
      document.removeEventListener("visibilitychange", remember);
    };
  }, [access, session]);
  const organization =
    AsyncResult.isSuccess(organizations) && target !== undefined
      ? organizations.value.find((item) => item.id === target)
      : undefined;
  const canonicalSlug = organization?.slug;
  useEffect(() => {
    if (rejectedResume) return;
    if (canonicalSlug !== undefined && canonicalSlug !== slug && target !== undefined) {
      const nextReference = OrganizationSlug.make(canonicalSlug);
      const previousTarget = registry.get(organizationTargetAtom(nextReference));
      if (previousTarget !== undefined && previousTarget !== target) {
        window.location.replace(
          location.pathname.replace(
            `/org/${encodeURIComponent(slug)}`,
            `/org/${encodeURIComponent(canonicalSlug)}`,
          ) +
            location.searchStr +
            (location.hash ? `#${location.hash}` : ""),
        );
        return;
      }
      registry.set(organizationTargetAtom(nextReference), target);
      void navigate({
        to: ".",
        params: { organizationSlug: canonicalSlug },
        search: true,
        hash: true,
        state: true,
        replace: true,
      });
    }
  }, [
    canonicalSlug,
    slug,
    target,
    registry,
    navigate,
    location.pathname,
    location.searchStr,
    location.hash,
    rejectedResume,
  ]);
  const checked = AsyncResult.isFailure(access) ? undefined : snapshot;
  const details =
    organization !== undefined && checked !== undefined
      ? {
          ...checked,
          checking: !AsyncResult.isSuccess(access),
          name: organization.name,
          slug: organization.slug,
          logo: organization.logo ?? null,
        }
      : null;
  if (rejectedResume) return <DashboardEntryPending />;
  return (
    <OrganizationRouteContext
      value={{
        organization: reference,
        slug,
        role: checked?.role,
        id: target,
        name: organization?.name,
        unavailable,
        metadataFailed: AsyncResult.isFailure(access) || AsyncResult.isFailure(organizations),
        retry: () => {
          refreshAccess();
          refreshOrganizations();
        },
      }}
    >
      <OrganizationContext value={details}>
        <HostedDashboard>{children}</HostedDashboard>
      </OrganizationContext>
    </OrganizationRouteContext>
  );
}

/** Resolve a destination when root restoration has no usable recent organization. */
export function OrganizationEntry({ allowCreate = true }: { readonly allowCreate?: boolean }) {
  const organizations = useAtomValue(organizationsAtom);
  const navigate = useNavigate();
  const refresh = useAtomRefresh(organizationsAtom);
  if (AsyncResult.isInitial(organizations)) return <DashboardEntryPending />;
  if (AsyncResult.isFailure(organizations))
    return (
      <DashboardEntryPending>
        <OrganizationLookupError retry={refresh} />
      </DashboardEntryPending>
    );
  const only = organizations.value.length === 1 ? organizations.value[0] : undefined;
  if (only)
    return (
      <Navigate to="/org/$organizationSlug/apps" params={{ organizationSlug: only.slug }} replace />
    );
  return (
    <HostedEntry
      title={organizations.value.length > 0 ? "Choose an organization" : "Your organizations"}
    >
      <div className="organization-entry flex flex-col gap-6 [&_.settings-form]:mt-0 [&_.settings-form_>_button]:self-stretch">
        {organizations.value.length > 0 && (
          <div className="flex flex-col gap-2">
            {organizations.value.map((organization) => (
              <Button key={organization.id} variant="outline" asChild>
                <Link
                  to="/org/$organizationSlug/apps"
                  params={{ organizationSlug: organization.slug }}
                >
                  {organization.name}
                </Link>
              </Button>
            ))}
          </div>
        )}
        {organizations.value.length === 0 &&
          (allowCreate ? (
            <CreateOrganization
              onCreated={({ slug }) =>
                navigate({ to: "/org/$organizationSlug/apps", params: { organizationSlug: slug } })
              }
            />
          ) : (
            <EmptyState size="compact" title="No organization access">
              Your account has no access to this instance. Contact an administrator.
            </EmptyState>
          ))}
      </div>
    </HostedEntry>
  );
}

/** Resource-based invitation returns resolve their exact organization, never a default. */
export function OrganizationDestination({
  organization,
}: {
  readonly organization: OrganizationId;
}) {
  const organizations = useAtomValue(organizationsAtom);
  const refresh = useAtomRefresh(organizationsAtom);
  if (AsyncResult.isInitial(organizations)) return <Spinner />;
  const target = AsyncResult.isSuccess(organizations)
    ? organizations.value.find((item) => item.id === organization)
    : undefined;
  if (!target && organizations.waiting) return <Spinner />;
  return target ? (
    <Navigate to="/org/$organizationSlug/apps" params={{ organizationSlug: target.slug }} replace />
  ) : (
    <EmptyState
      title="Unable to open this organization"
      action={
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={refresh}>Try again</Button>
          <Link className="text-sm underline underline-offset-4" to="/">
            Choose organization
          </Link>
        </div>
      }
    />
  );
}
/** Compact organization mark shared by the switcher and organization pickers. */
export function OrganizationAvatar({
  name,
  logo,
}: {
  readonly name: string;
  readonly logo?: string | null | undefined;
}) {
  return (
    <Avatar className="size-6 rounded-[5px] border font-mono font-medium" aria-hidden>
      {logo && (
        <AvatarImage src={logo} alt="" referrerPolicy="no-referrer" className="object-contain" />
      )}
      <AvatarFallback className="rounded-[5px] text-[11px]">
        {name.trim().slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** Organization picker shared by cloud and self-host. */
export function OrganizationSwitcher({ allowCreate = true }: { readonly allowCreate?: boolean }) {
  const organizations = useAtomValue(organizationsAtom);
  const organization = useContext(OrganizationContext);
  const route = useOrganizationRoute();
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (route.metadataFailed)
    return (
      <Button variant="ghost" className="h-12 w-full justify-start text-xs" onClick={route.retry}>
        Retry organization
      </Button>
    );
  if (!organization || !AsyncResult.isSuccess(organizations))
    return <OrganizationSwitcherSkeleton />;
  return (
    <div className="organization-switcher min-w-0 [padding:0_0_8px] [&_.auth-error]:mt-2 [&_.auth-error]:text-[12px] max-[640px]:pb-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={triggerRef}
          className="organization-trigger flex items-center gap-2 w-full min-h-10 p-[6px] rounded-[6px] text-[13px] text-left hover:bg-accent [&[data-state='open']]:bg-accent disabled:cursor-wait disabled:opacity-60"
          aria-label={`Organization: ${organization.name}`}
        >
          <OrganizationAvatar name={organization.name} logo={organization.logo} />
          <span className="organization-name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
            {organization.name}
          </span>
          <span className="organization-chevron flex items-center justify-center shrink-0 w-4.5 text-muted-foreground">
            <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} size={14} aria-hidden />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-[248px] max-w-[calc(100vw-24px)] rounded-lg p-0 shadow-[0_8px_24px_#0003]"
          side="top"
          sideOffset={6}
          align="start"
          collisionPadding={12}
          aria-label="Switch organization"
          loop
          onCloseAutoFocus={(event) => {
            if (creating) event.preventDefault();
          }}
        >
          <DropdownMenuRadioGroup
            className="max-h-[260px] overflow-y-auto scroll-p-1 p-[5px]"
            value={organization.organization}
          >
            {organizations.value.map((item) => (
              <DropdownMenuRadioItem
                className="min-h-[38px] cursor-pointer py-1.5 pr-8 pl-2 text-[13px] [&>[data-slot=dropdown-menu-item-indicator]]:right-2 [&>[data-slot=dropdown-menu-item-indicator]]:left-auto"
                key={item.id}
                value={item.id}
                textValue={item.name}
                onSelect={async (event) => {
                  event.preventDefault();
                  if (item.id === organization.organization) {
                    setOpen(false);
                    return;
                  }
                  setOpen(false);
                  const previous = registry.get(
                    organizationTargetAtom(OrganizationSlug.make(item.slug)),
                  );
                  if (previous !== undefined && previous !== item.id) {
                    window.location.assign(`/org/${encodeURIComponent(item.slug)}/apps`);
                    return;
                  }
                  registry.set(organizationTargetAtom(OrganizationSlug.make(item.slug)), item.id);
                  await navigate({
                    to: "/org/$organizationSlug/apps",
                    params: { organizationSlug: item.slug },
                  });
                }}
              >
                <OrganizationAvatar name={item.name} logo={item.logo} />
                <span className="organization-name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                  {item.name}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator className="m-0" />
          {allowCreate && (
            <div className="p-[5px]">
              <DropdownMenuItem
                className="min-h-9 p-2 text-xs text-muted-foreground"
                onSelect={() => setCreating(true)}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} size={16} aria-hidden />
                Create organization
              </DropdownMenuItem>
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrganizationDialog
        open={creating}
        onOpenChange={setCreating}
        triggerRef={triggerRef}
      />
    </div>
  );
}
