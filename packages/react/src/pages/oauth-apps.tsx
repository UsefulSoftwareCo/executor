import { useMemo, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { ChevronDownIcon } from "lucide-react";
import {
  OAuthClientSlug,
  type Connection,
  type OAuthClientSummary,
  type OAuthGrant,
  type Owner,
} from "@executor-js/sdk/shared";
import { toast } from "sonner";

import {
  connectionsAllAtom,
  oauthClientsOptimisticAtom,
  removeOAuthClientOptimistic,
} from "../api/atoms";
import { oauthClientWriteKeys } from "../api/reactivity-keys";
import { ownerLabel } from "../api/owner-display";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { Alert, AlertDescription, AlertTitle } from "../components/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { OAuthClientForm, type OAuthClientFormPrefill } from "../components/oauth-client-form";

// ---------------------------------------------------------------------------
// OAuth apps page (v2).
//
// Registered OAuth clients ("apps") are the credentials behind OAuth-minted
// connections: each app holds the client id/secret + endpoints/scopes a flow
// runs through. This page lists them grouped per owner (Workspace vs Personal),
// shows each app's endpoints/scopes/grant/client id, the connections it backs,
// and lets the user register, edit, or remove one.
//
// Removal NEVER cascades into connections — an orphaned connection keeps its
// stored slug and surfaces a reconnect prompt at its next token refresh. The
// remove dialog warns (does not block) when an app is still in use.
// ---------------------------------------------------------------------------

// Owner ordering: Workspace (org) first, then Personal (user). Mirrors the
// policies page grouping so the two surfaces read the same.
const OWNER_ORDER: readonly Owner[] = ["org", "user"];

const GRANT_LABEL: Record<OAuthGrant, string> = {
  authorization_code: "Authorization code",
  client_credentials: "Client credentials",
};

const grantLabel = (grant: OAuthGrant): string => GRANT_LABEL[grant];

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests) — usage map + per-owner grouping.
// ---------------------------------------------------------------------------

/** Group apps by owner, preserving `OWNER_ORDER` and dropping empty groups.
 *  Within a group, original list order is kept. */
export function groupClientsByOwner(
  clients: readonly OAuthClientSummary[],
): ReadonlyArray<{ readonly owner: Owner; readonly clients: readonly OAuthClientSummary[] }> {
  return OWNER_ORDER.flatMap((owner: Owner) => {
    const group = clients.filter((client: OAuthClientSummary) => client.owner === owner);
    return group.length === 0 ? [] : [{ owner, clients: group }];
  });
}

/** Build an owner+slug → connections map so each app can show what it backs.
 *  Connection rows can reference either a personal or workspace app with the
 *  same slug, so owner is part of the key. Static connections (null
 *  `oauthClient`) are skipped. */
const oauthClientUsageKey = (owner: Owner | null | undefined, slug: OAuthClientSlug): string =>
  `${owner ?? "org"}\0${String(slug)}`;

export function buildUsageMap(
  connections: readonly Connection[],
): ReadonlyMap<string, readonly Connection[]> {
  const map = new Map<string, Connection[]>();
  for (const connection of connections) {
    const slug = connection.oauthClient;
    if (slug == null) continue;
    const key = oauthClientUsageKey(connection.oauthClientOwner, slug);
    const existing = map.get(key);
    if (existing) existing.push(connection);
    else map.set(key, [connection]);
  }
  return map;
}

/** Connections backing one app, or an empty array. */
export function connectionsUsingClient(
  usage: ReadonlyMap<string, readonly Connection[]>,
  client: Pick<OAuthClientSummary, "owner" | "slug">,
): readonly Connection[] {
  return usage.get(oauthClientUsageKey(client.owner, client.slug)) ?? [];
}

// ---------------------------------------------------------------------------
// Field row — a labeled, monospace, copyable value.
// ---------------------------------------------------------------------------

function MetaField(props: {
  readonly label: string;
  readonly value: string;
  readonly copy?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate font-mono text-xs text-foreground">{props.value}</span>
        {props.copy ? <CopyButton value={props.value} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App card
// ---------------------------------------------------------------------------

function OAuthAppCard(props: {
  readonly client: OAuthClientSummary;
  readonly connections: readonly Connection[];
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { client, connections } = props;
  const [expanded, setExpanded] = useState(false);
  const inUse = connections.length > 0;

  return (
    <CardStackEntry className="flex-col items-stretch gap-3">
      <div className="flex w-full items-start gap-3">
        <CardStackEntryContent>
          <CardStackEntryTitle className="flex items-center gap-2 font-mono text-sm">
            <span className="truncate">{String(client.slug)}</span>
            <Badge variant="outline" className="font-sans text-[10px]">
              {grantLabel(client.grant)}
            </Badge>
          </CardStackEntryTitle>
          <CardStackEntryDescription>{ownerLabel(client.owner)} app</CardStackEntryDescription>
        </CardStackEntryContent>
        <CardStackEntryActions>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Actions for ${String(client.slug)}`}
              >
                <svg viewBox="0 0 16 16" className="size-3">
                  <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={props.onEdit}>Edit</DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive text-sm"
                onClick={props.onRemove}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardStackEntryActions>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetaField label="Client ID" value={client.clientId} copy />
        {client.grant === "authorization_code" ? (
          <MetaField label="Authorization URL" value={client.authorizationUrl} copy />
        ) : null}
        <MetaField label="Token URL" value={client.tokenUrl} copy />
        {client.resource ? <MetaField label="Resource" value={client.resource} copy /> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((prev: boolean) => !prev)}
          disabled={!inUse}
          className="h-auto w-fit gap-1 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-100"
        >
          {inUse ? (
            <ChevronDownIcon
              className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          ) : null}
          Used by {connections.length} connection{connections.length === 1 ? "" : "s"}
        </Button>
        {inUse && expanded ? (
          <ul className="flex flex-col gap-1 border-l border-border/60 pl-3">
            {connections.map((connection: Connection) => (
              <li
                key={`${connection.owner}.${String(connection.integration)}.${String(connection.name)}`}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="font-mono text-foreground">{String(connection.integration)}</span>
                <span className="truncate">{String(connection.name)}</span>
                <span className="ml-auto shrink-0 rounded border border-border px-1 py-0.5 text-[10px] leading-none">
                  {ownerLabel(connection.owner)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </CardStackEntry>
  );
}

// ---------------------------------------------------------------------------
// Remove-confirm dialog — warns (does not block) when the app is in use.
// ---------------------------------------------------------------------------

function RemoveAppDialog(props: {
  readonly client: OAuthClientSummary;
  readonly connections: readonly Connection[];
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const { client, connections } = props;
  const inUse = connections.length > 0;
  return (
    <Dialog open onOpenChange={(open: boolean) => (open ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {String(client.slug)}?</DialogTitle>
          <DialogDescription>
            This permanently removes the {ownerLabel(client.owner).toLowerCase()} OAuth app and its
            stored client credentials.
          </DialogDescription>
        </DialogHeader>

        {inUse ? (
          <Alert variant="destructive">
            <AlertTitle>
              This app backs {connections.length} connection
              {connections.length === 1 ? "" : "s"}
            </AlertTitle>
            <AlertDescription>
              <p>
                Removing it won&apos;t delete those connections, but they&apos;ll need to reconnect
                at their next token refresh.
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {connections.map((connection: Connection) => (
                  <li
                    key={`${connection.owner}.${String(connection.integration)}.${String(connection.name)}`}
                    className="font-mono text-xs"
                  >
                    {String(connection.integration)} / {String(connection.name)}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={props.onConfirm}>
            Remove app
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add / edit dialog — wraps the shared `OAuthClientForm`.
// ---------------------------------------------------------------------------

function AppFormDialog(props: {
  readonly title: string;
  readonly existingSlugs: readonly string[];
  readonly fixedSlug?: OAuthClientSlug;
  readonly fixedOwner?: Owner;
  readonly prefill?: OAuthClientFormPrefill;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open: boolean) => (open ? undefined : props.onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <OAuthClientForm
          integrationName="OAuth app"
          existingSlugs={props.existingSlugs}
          fixedSlug={props.fixedSlug}
          fixedOwner={props.fixedOwner}
          prefill={props.prefill}
          onCreated={() => props.onClose()}
          onCancel={props.onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

// What the page is currently editing/removing/adding. A discriminated union so
// only one dialog is ever open.
type OpenDialog =
  | { readonly kind: "none" }
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly client: OAuthClientSummary }
  | { readonly kind: "remove"; readonly client: OAuthClientSummary };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function OAuthAppsPage() {
  const clients = useAtomValue(oauthClientsOptimisticAtom);
  const connections = useAtomValue(connectionsAllAtom);
  const doRemove = useAtomSet(removeOAuthClientOptimistic, { mode: "promise" });
  const [dialog, setDialog] = useState<OpenDialog>({ kind: "none" });

  // Connections list is a secondary read; treat a not-yet-loaded list as empty
  // rather than blocking the page on it. The usage badges fill in on its load.
  const connectionRows = useMemo(
    () => (AsyncResult.isSuccess(connections) ? connections.value : []),
    [connections],
  );
  const usage = useMemo(() => buildUsageMap(connectionRows), [connectionRows]);

  const handleRemove = async (client: OAuthClientSummary) => {
    setDialog({ kind: "none" });
    await doRemove({
      params: { slug: client.slug },
      payload: { owner: client.owner },
      reactivityKeys: oauthClientWriteKeys,
    });
    toast.success(`Removed ${String(client.slug)}`);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-10 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[2rem] leading-none tracking-tight text-foreground">
              OAuth apps
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Registered OAuth clients — the client id/secret, endpoints, and scopes that back your
              OAuth connections. Workspace apps are shared with everyone; personal apps are yours
              only. Each person still mints their own connection against a shared app.
            </p>
          </div>
          <Button type="button" onClick={() => setDialog({ kind: "add" })} className="shrink-0">
            Add OAuth app
          </Button>
        </div>

        {AsyncResult.match(clients, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Loading OAuth apps…</p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">Failed to load OAuth apps</p>
            </div>
          ),
          onSuccess: ({ value }) => {
            const visibleClients = value.filter(
              (client: OAuthClientSummary) => client.origin.kind !== "dynamic_client_registration",
            );
            const groups = groupClientsByOwner(visibleClients);
            const existingSlugs = value.map((client: OAuthClientSummary) => String(client.slug));
            // Dialogs render regardless of how many apps exist — in particular
            // the "add" dialog must be reachable from the empty state so a fresh
            // workspace can register its first app.
            const dialogs = (
              <>
                {dialog.kind === "add" ? (
                  <AppFormDialog
                    title="Register an OAuth app"
                    existingSlugs={existingSlugs}
                    onClose={() => setDialog({ kind: "none" })}
                  />
                ) : null}

                {dialog.kind === "edit" ? (
                  <AppFormDialog
                    title={`Edit ${String(dialog.client.slug)}`}
                    existingSlugs={existingSlugs}
                    fixedSlug={dialog.client.slug}
                    fixedOwner={dialog.client.owner}
                    prefill={{
                      authorizationUrl: dialog.client.authorizationUrl,
                      tokenUrl: dialog.client.tokenUrl,
                      resource: dialog.client.resource ?? null,
                      grant: dialog.client.grant,
                      clientId: dialog.client.clientId,
                    }}
                    onClose={() => setDialog({ kind: "none" })}
                  />
                ) : null}

                {dialog.kind === "remove" ? (
                  <RemoveAppDialog
                    client={dialog.client}
                    connections={connectionsUsingClient(usage, dialog.client)}
                    onConfirm={() => void handleRemove(dialog.client)}
                    onClose={() => setDialog({ kind: "none" })}
                  />
                ) : null}
              </>
            );
            if (groups.length === 0) {
              return (
                <div className="flex flex-col gap-6">
                  <CardStack>
                    <CardStackHeader>Registered apps</CardStackHeader>
                    <CardStackContent>
                      <CardStackEntry>
                        <CardStackEntryContent>
                          <CardStackEntryDescription>
                            No OAuth apps yet. Register one to back OAuth connections with your own
                            client id/secret.
                          </CardStackEntryDescription>
                        </CardStackEntryContent>
                      </CardStackEntry>
                    </CardStackContent>
                  </CardStack>
                  {dialogs}
                </div>
              );
            }
            return (
              <div className="flex flex-col gap-6">
                {groups.map((group) => (
                  <CardStack key={group.owner}>
                    <CardStackHeader>{ownerLabel(group.owner)}</CardStackHeader>
                    <CardStackContent>
                      {group.clients.map((client: OAuthClientSummary) => (
                        <OAuthAppCard
                          key={`${client.owner}.${String(client.slug)}`}
                          client={client}
                          connections={connectionsUsingClient(usage, client)}
                          onEdit={() => setDialog({ kind: "edit", client })}
                          onRemove={() => setDialog({ kind: "remove", client })}
                        />
                      ))}
                    </CardStackContent>
                  </CardStack>
                ))}

                {dialogs}
              </div>
            );
          },
        })}
      </div>
    </div>
  );
}
