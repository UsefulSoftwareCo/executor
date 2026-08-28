import { useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { HealthStatus, Integration, IntegrationSlug } from "@executor-js/sdk/shared";
import { useIntegrationPlugins } from "@executor-js/sdk/client";

import {
  ADMIN_USERS_PAGE_SIZE,
  adminUserConnectionsAtom,
  adminUsersWithConnectionsAtom,
} from "../api/admin-atoms";
import { integrationsOptimisticAtom } from "../api/atoms";
import { ownerLabel } from "../api/owner-display";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { ErrorState } from "../components/error-state";
import {
  IntegrationFavicon,
  integrationInferredUrl,
  integrationPresetIconUrl,
} from "../components/integration-favicon";
import { PageContainer, PageHeader } from "../components/page";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/sheet";
import { Skeleton } from "../components/skeleton";
import {
  adminUserCopyableEmail,
  adminUserTitle,
  connectionHealthStatus,
  connectLinkUrl,
  formatAdminDate,
  formatLastSeen,
  integrationConnectionStates,
  lastSeenTitle,
  pageNumber,
  shortenExternalId,
  splitPage,
  type AdminCatalogRow,
  type AdminConnectionRow,
  type AdminUserIdentityRow,
} from "../lib/admin-users-display";
import {
  HEALTH_INDICATOR_COLOR,
  HEALTH_STATUS_LABEL,
  HEALTH_TEXT_CLASS,
} from "../lib/health-display";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { EmptyState } from "../components/empty-state";

// ---------------------------------------------------------------------------
// Admin · Users — the tenant-wide operator view.
//
// The product plane answers "what can I reach"; this page answers the owner's
// question: who are my users, and what has each of them connected. It reads the
// admin plane only (`/admin/users*`), which is read-only by construction, so
// there is nothing to mutate here — every affordance is a read or a copy.
//
// ACCESS: the server is the gate. A plain member's request comes back 403 (401
// with no session), and the page renders an explicit denial rather than an
// empty table, so "you may not see this" never reads as "there is nobody here".
// The nav item is separately hidden from non-admins (see lib/admin-access), but
// that is convenience — this is the surface that actually refuses.
//
// The row is a button rather than a link: a user has no page of its own, and a
// detail sheet keeps the list's paging position while an operator scans several
// users in a row.
// ---------------------------------------------------------------------------

type AdminUserRow = {
  readonly externalId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly status: string | null;
  /** Joined server-side from the host's member directory. Null whenever the
   *  host couldn't resolve the id — see `adminUserTitle` for what that renders
   *  as. */
  readonly email: string | null;
  readonly displayName: string | null;
  readonly connections: readonly AdminConnectionRow[];
};

/** 401/403 from the admin plane. Both mean "not an operator here" and get the
 *  same denial: the distinction (no session vs wrong role) is the server's, and
 *  a signed-in member reading "unauthorized" would only confuse. */
const isAccessDenied = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      Predicate.isTagged(error, "AdminUsersForbidden") ||
      Predicate.isTagged(error, "AdminUsersUnauthorized"),
  });

// ── Access denied ───────────────────────────────────────────────────────────

function AccessDenied() {
  return (
    <div className="rounded-lg border border-border bg-card p-8">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Admin only
      </p>
      <h2 className="mt-2 text-base font-semibold text-foreground">
        You don&apos;t have access to this workspace&apos;s users
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
        Reading every user and what they&apos;ve connected requires an admin role. Ask an admin of
        this workspace if you need it.
      </p>
    </div>
  );
}

// ── Health ──────────────────────────────────────────────────────────────────

/** The shared health vocabulary, rendered from a stored verdict.
 *
 *  Deliberately NOT `IntegrationHealthSummary`: that component probes upstream
 *  on mount through the product plane, which is both the wrong plane here (an
 *  admin is not the credential's owner) and the wrong behavior (opening an
 *  admin view must not fire traffic at every user's provider). This reads the
 *  `lastHealth` the admin payload already carries. */
function HealthIndicator(props: { readonly status: HealthStatus }) {
  const label = HEALTH_STATUS_LABEL[props.status];
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`Status: ${label}`}>
      <span
        className={`font-mono text-[11px] font-medium uppercase tracking-[0.08em] ${HEALTH_TEXT_CLASS[props.status]}`}
      >
        {label}
      </span>
      <span
        aria-label={`Status: ${label}`}
        className={`size-2 rounded-full ${HEALTH_INDICATOR_COLOR[props.status].dot}`}
      />
    </span>
  );
}

// ── Integration icons ───────────────────────────────────────────────────────

/** The catalog joined into a favicon lookup. The admin payload carries only a
 *  slug per connection (no kind, no display URL — the platform view hands out
 *  nothing it doesn't have to), so brand marks come from the tenant's own
 *  integration catalog, which the admin can read on the product plane. */
type IconLookup = (integration: IntegrationSlug) => {
  readonly icon: string | null;
  readonly url: string | undefined;
  readonly name: string;
};

const useIntegrationIcons = (): IconLookup => {
  const catalog = useAtomValue(integrationsOptimisticAtom);
  const integrationPlugins = useIntegrationPlugins();
  const integrations = Option.getOrElse(
    AsyncResult.value(catalog),
    (): readonly Integration[] => [],
  );

  return (integration) => {
    const slug = String(integration);
    const found = integrations.find((row) => String(row.slug) === slug);
    const name = found?.name || slug;
    return {
      icon: found
        ? integrationPresetIconUrl(
            { id: slug, kind: found.kind, name, url: found.displayUrl },
            integrationPlugins,
          )
        : null,
      url: found?.displayUrl ?? integrationInferredUrl({ id: slug, name }) ?? undefined,
      name,
    };
  };
};

/** The catalog rows this view needs — slug plus kind, since `kind` is what says
 *  whether an integration can be connected at all (see
 *  `isConnectableIntegration`). Empty while the catalog loads, which degrades to
 *  "connected only" rather than blocking the users table on a second request. */
const useCatalogRows = (): readonly AdminCatalogRow[] => {
  const catalog = useAtomValue(integrationsOptimisticAtom);
  return Option.match(AsyncResult.value(catalog), {
    onNone: (): readonly AdminCatalogRow[] => [],
    onSome: (integrations: readonly Integration[]) =>
      integrations.map((row) => ({ slug: row.slug, kind: row.kind })),
  });
};

/**
 * The connection summary: one slot per integration in the catalog, lit when
 * this user has connected it and greyed when they haven't.
 *
 * Showing the not-connected slots is the point — the grid answers "what is
 * available and what has this person actually set up", which a list of only
 * their connections cannot.
 */
function ConnectionGrid(props: {
  readonly catalog: readonly AdminCatalogRow[];
  readonly connections: readonly AdminConnectionRow[];
  readonly icons: IconLookup;
}) {
  const states = integrationConnectionStates(props.catalog, props.connections);
  if (states.length === 0) {
    return <span className="font-mono text-[11px] text-muted-foreground">No integrations</span>;
  }

  const connectedCount = states.filter((state) => state.connected).length;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {states.slice(0, 8).map((state) => {
          const { icon, url, name } = props.icons(state.integration);
          return (
            <span
              key={state.integration}
              // State on data-* (the repo convention) so the connected/not-
              // connected distinction is readable without parsing classes.
              data-slot="admin-user-integration"
              data-integration={String(state.integration)}
              data-connected={state.connected ? "true" : "false"}
              title={`${name} — ${state.connected ? "connected" : "not connected"}`}
              className={
                state.connected
                  ? "flex size-5 items-center justify-center"
                  : "flex size-5 items-center justify-center opacity-25 grayscale"
              }
            >
              <IntegrationFavicon
                icon={icon}
                integrationId={String(state.integration)}
                url={url}
                size={16}
              />
            </span>
          );
        })}
      </div>
      <span
        data-slot="admin-user-connection-count"
        className="shrink-0 font-mono text-[11px] text-muted-foreground"
        title={`${connectedCount} of ${states.length} integrations connected`}
      >
        {connectedCount}/{states.length}
      </span>
    </div>
  );
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The user cell: who this is, then the opaque id underneath.
 *
 * The host joins email/name onto each row server-side, so the headline is
 * something an operator recognizes and the `externalId` becomes the supporting
 * line — still mono, still carrying the full value in its title, still under the
 * same `data-slot` it always had, because the id is what identifies a row to
 * anything reading this table. When the host resolved no identity the cell
 * collapses back to exactly the single mono id line this table has always shown.
 *
 * NO copy button lives here: the row itself is a `<button>` (a user has no page
 * of its own, so the row opens a detail sheet), and a button inside a button is
 * invalid markup that swallows its own clicks. The copy affordances live one
 * click away in the sheet header, on the same values.
 */
function UserIdentityCell(props: { readonly user: AdminUserIdentityRow }) {
  const title = adminUserTitle(props.user);

  if (title.primaryIsId) {
    return (
      <span
        data-slot="admin-user-id"
        className="min-w-0 truncate font-mono text-sm text-foreground"
        title={props.user.externalId}
      >
        {shortenExternalId(title.primary)}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span
        data-slot="admin-user-name"
        className="truncate text-sm text-foreground"
        title={title.primary}
      >
        {title.primary}
      </span>
      <span
        data-slot="admin-user-id"
        className="truncate font-mono text-[11px] text-muted-foreground"
        title={props.user.externalId}
      >
        {shortenExternalId(props.user.externalId)}
      </span>
    </span>
  );
}

/**
 * The sheet header: the same title treatment as the row, plus the copy
 * affordances the row can't carry.
 *
 * Two separate buttons rather than one, because they yield different things and
 * an operator wants a specific one: the email is what they paste into a mail
 * client or a support ticket, and the `externalId` is what they paste into a log
 * search or an API call. A single "copy" would force them to guess which.
 *
 * The email button is absent — not disabled — when the host resolved no email,
 * since there is nothing to put on the clipboard. The id button is always
 * present, whether the id is the headline (no identity resolved) or the
 * supporting line: every user has an id by definition, and it is the value that
 * identifies them to logs and to the API.
 */
function UserDetailTitle(props: { readonly user: AdminUserRow }) {
  const title = adminUserTitle(props.user);
  const email = adminUserCopyableEmail(props.user);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <SheetTitle
          data-slot="admin-user-detail-title"
          className={
            title.primaryIsId ? "truncate font-mono text-sm" : "truncate text-sm font-semibold"
          }
          title={title.primary}
        >
          {title.primary}
        </SheetTitle>
        {email ? (
          <CopyButton value={email} label="Copy email" />
        ) : (
          title.primaryIsId && <CopyButton value={props.user.externalId} label="Copy ID" />
        )}
      </div>
      {title.secondary !== null && (
        <div className="flex min-w-0 items-center gap-1">
          <span
            data-slot="admin-user-detail-id"
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={props.user.externalId}
          >
            {props.user.externalId}
          </span>
          <CopyButton value={props.user.externalId} label="Copy ID" />
        </div>
      )}
    </div>
  );
}

// ── Detail sheet ────────────────────────────────────────────────────────────

function UserDetail(props: {
  readonly user: AdminUserRow;
  readonly catalog: readonly AdminCatalogRow[];
  readonly icons: IconLookup;
  readonly orgSlug: string | undefined;
}) {
  const result = useAtomValue(adminUserConnectionsAtom(props.user.externalId));
  const refresh = useAtomRefresh(adminUserConnectionsAtom(props.user.externalId));
  // The connect link targets the recipient's own session, so it is built for
  // this deployment's origin and copied out — never navigated to from here. It
  // carries THIS admin's org so a multi-org recipient connects in the workspace
  // the link came from, not whichever one their session defaults to.
  const origin = globalThis.window?.location?.origin ?? "";

  if (isAsyncResultLoading(result)) {
    return (
      <div className="flex flex-col gap-2 p-6">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12" />
        ))}
      </div>
    );
  }

  return AsyncResult.match(result, {
    onInitial: () => (
      <div className="flex flex-col gap-2 p-6">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12" />
        ))}
      </div>
    ),
    onFailure: (failure) =>
      isAccessDenied(failure.cause) ? (
        <div className="p-6">
          <AccessDenied />
        </div>
      ) : (
        <div className="p-6">
          <ErrorState message="Couldn't load this user's connections" onRetry={refresh} />
        </div>
      ),
    onSuccess: ({ value }) => {
      const states = integrationConnectionStates(props.catalog, value.connections);
      const connected = states.filter((state) => state.connected);
      const available = states.filter((state) => !state.connected);

      return (
        <div className="flex flex-col gap-8 overflow-y-auto p-6">
          <section>
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Connected · {connected.length}
            </h3>
            {connected.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                This user hasn&apos;t connected anything yet. Send them a connect link below to get
                started.
              </p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
                {connected.flatMap((state) =>
                  state.connections.map((connection) => {
                    const { icon, url, name } = props.icons(connection.integration);
                    return (
                      <div
                        key={`${connection.integration}/${connection.owner}/${connection.name}`}
                        className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"
                      >
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                          <IntegrationFavicon
                            icon={icon}
                            integrationId={String(connection.integration)}
                            url={url}
                            size={16}
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium text-foreground">{name}</p>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              {ownerLabel(connection.owner)}
                            </span>
                          </div>
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                            {connection.name}
                          </p>
                          {connection.oauthScope ? (
                            <p
                              className="mt-1.5 break-words font-mono text-[11px] leading-5 text-muted-foreground"
                              title={connection.oauthScope}
                            >
                              {connection.oauthScope}
                            </p>
                          ) : (
                            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                              No OAuth scope — static credential
                            </p>
                          )}
                        </div>
                        <HealthIndicator status={connectionHealthStatus(connection)} />
                      </div>
                    );
                  }),
                )}
              </div>
            )}
          </section>

          <section>
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Not connected · {available.length}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Copy a link and send it to this user — it opens the connect flow in their own session.
            </p>
            {available.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                This user has connected every integration in the catalog.
              </p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
                {available.map((state) => {
                  const { icon, url, name } = props.icons(state.integration);
                  const link = connectLinkUrl(state.integration, origin, props.orgSlug);
                  return (
                    <div
                      key={state.integration}
                      className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center opacity-40 grayscale">
                        <IntegrationFavicon
                          icon={icon}
                          integrationId={String(state.integration)}
                          url={url}
                          size={16}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{name}</p>
                        <p
                          data-slot="admin-user-connect-link"
                          className="truncate font-mono text-[11px] text-muted-foreground"
                        >
                          {link}
                        </p>
                      </div>
                      <CopyButton value={link} label="Copy link" />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      );
    },
  });
}

// ── Page ────────────────────────────────────────────────────────────────────

export function AdminUsersPage() {
  useExecutorDocumentTitle("Users");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);

  const page = { limit: ADMIN_USERS_PAGE_SIZE, offset };
  const result = useAtomValue(adminUsersWithConnectionsAtom(page));
  const refresh = useAtomRefresh(adminUsersWithConnectionsAtom(page));
  const catalog = useCatalogRows();
  const icons = useIntegrationIcons();
  // The route is `/{-$orgSlug}/users`: the segment is OPTIONAL, so this reads
  // `undefined` on any host that renders no segment and the link falls back to
  // the bare form. Both cloud and self-host do canonicalize onto a slug (self-
  // host onto `default`), so in practice the prefixed form is what ships — but
  // the optional param is the contract, not an assumption about the host.
  const { orgSlug } = useParams({ strict: false }) as { orgSlug?: string };

  const header = (
    <PageHeader
      title="Users"
      description="Everyone who has used this workspace, and what each of them has connected."
    />
  );

  const loading = (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-14" />
      ))}
    </div>
  );

  return (
    <PageContainer>
      {header}

      {isAsyncResultLoading(result)
        ? loading
        : AsyncResult.match(result, {
            onInitial: () => loading,
            onFailure: (failure) =>
              isAccessDenied(failure.cause) ? (
                <AccessDenied />
              ) : (
                <ErrorState message="Couldn't load users" onRetry={refresh} />
              ),
            onSuccess: ({ value }) => {
              const { rows, hasNext } = splitPage(value.users, ADMIN_USERS_PAGE_SIZE);

              if (rows.length === 0) {
                return (
                  <EmptyState
                    title={offset === 0 ? "No users yet" : "No users on this page"}
                    description={
                      offset === 0
                        ? "A user appears here the first time they reach this workspace or connect an account."
                        : "Go back a page to see this workspace's users."
                    }
                    action={
                      offset > 0 ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setOffset(Math.max(0, offset - ADMIN_USERS_PAGE_SIZE))}
                        >
                          Previous
                        </Button>
                      ) : undefined
                    }
                  />
                );
              }

              return (
                <>
                  <div
                    className="overflow-hidden rounded-lg border border-border bg-card"
                    data-slot="admin-users-table"
                  >
                    <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground md:grid-cols-[1.6fr_0.8fr_0.9fr_1.1fr]">
                      <span>User</span>
                      <span className="hidden md:block">Created</span>
                      <span className="hidden md:block">Last seen</span>
                      <span className="text-right md:text-left">Connections</span>
                    </div>
                    {rows.map((user: AdminUserRow) => (
                      // oxlint-disable-next-line react/forbid-elements
                      <button
                        key={user.externalId}
                        type="button"
                        onClick={() => setSelected(user)}
                        data-slot="admin-user-row"
                        className="grid w-full grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-accent md:grid-cols-[1.6fr_0.8fr_0.9fr_1.1fr]"
                      >
                        <UserIdentityCell user={user} />
                        <span className="hidden font-mono text-xs text-muted-foreground md:block">
                          {formatAdminDate(user.createdAt)}
                        </span>
                        <span
                          className="hidden font-mono text-xs text-muted-foreground md:block"
                          title={lastSeenTitle(user.lastSeenAt)}
                        >
                          {formatLastSeen(user.lastSeenAt)}
                        </span>
                        <span className="justify-self-end md:justify-self-start">
                          <ConnectionGrid
                            catalog={catalog}
                            connections={user.connections}
                            icons={icons}
                          />
                        </span>
                      </button>
                    ))}
                  </div>

                  {(hasNext || offset > 0) && (
                    <div className="mt-4 flex items-center justify-between">
                      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                        Page {pageNumber(offset, ADMIN_USERS_PAGE_SIZE)}
                      </span>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={offset === 0}
                          onClick={() => setOffset(Math.max(0, offset - ADMIN_USERS_PAGE_SIZE))}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!hasNext}
                          onClick={() => setOffset(offset + ADMIN_USERS_PAGE_SIZE)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              );
            },
          })}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader className="border-b border-border">
                <UserDetailTitle user={selected} />
                <SheetDescription>
                  Created {formatAdminDate(selected.createdAt)} · last seen{" "}
                  <span title={lastSeenTitle(selected.lastSeenAt)}>
                    {formatLastSeen(selected.lastSeenAt).toLowerCase()}
                  </span>
                </SheetDescription>
              </SheetHeader>
              <UserDetail user={selected} catalog={catalog} icons={icons} orgSlug={orgSlug} />
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
