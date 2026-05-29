import { Suspense, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ConnectionId, ConnectionInUseError, ScopeId } from "@executor-js/sdk/shared";
import { toast } from "sonner";
import { ChevronDownIcon } from "lucide-react";

import {
  connectionIdentityAtom,
  connectionUsagesAtom,
  connectionsOptimisticAtom,
  removeConnectionOptimistic,
  sourcesOptimisticAtom,
  updateConnectionIdentity,
} from "../api/atoms";
import { connectionWriteKeys } from "../api/reactivity-keys";
import { useScope, useScopeStack } from "../hooks/use-scope";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { Input } from "../components/input";
import { FieldLabel } from "../components/field";
import { SourceIconWithAccount } from "../components/source-icon-with-account";
import { sourcePresetIconUrl } from "../components/source-favicon";
import { useSourcePlugins } from "@executor-js/sdk/client";

// ---------------------------------------------------------------------------
// Provider display
// ---------------------------------------------------------------------------

// Friendly labels for the internal provider keys minted by plugins.
// Falls through to the raw key so new providers still render something.
const providerDisplayNames: Record<string, string> = {
  oauth2: "OAuth2",
};

const displayProvider = (provider: string): string => providerDisplayNames[provider] ?? provider;

const isConnectionInUseError = Schema.is(ConnectionInUseError);

type ConnectionListItem = {
  readonly id: string;
  readonly scopeId: string;
  readonly provider: string;
  readonly identityLabel: string | null;
  readonly expiresAt: number | null;
  readonly oauthScope: string | null;
  readonly identityOverride: {
    readonly displayName: string | null;
    readonly email: string | null;
    readonly avatarUrl: string | null;
  } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

const connectionScopeLabel = (
  scopeId: string,
  stack: readonly { readonly id: string; readonly name: string }[],
) => {
  const index = stack.findIndex((entry) => entry.id === scopeId);
  if (index === 0) return "Personal";
  if (index > 0) return stack[index]?.name ?? "Shared";
  return "Scoped";
};

const splitScopes = (oauthScope: string | null): readonly string[] =>
  oauthScope?.split(/\s+/).filter((scope) => scope.length > 0) ?? [];

const compactScope = (scope: string): string => {
  if (!URL.canParse(scope)) return scope;
  const url = new URL(scope);
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  return last ?? scope;
};

type LinkedSource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url?: string;
  readonly connectionIds?: readonly string[];
};

// ---------------------------------------------------------------------------
// Used-by footer — same shape as the secrets page. Returns null when a
// connection isn't referenced anywhere so newly-created connections
// don't get a stray "Used by 0" line before any source binds to them.
// ---------------------------------------------------------------------------

function ConnectionDetails(props: {
  scopeId: ScopeId;
  connection: ConnectionListItem;
  open: boolean;
}) {
  const sourcePlugins = useSourcePlugins();
  const usages = useAtomValue(
    connectionUsagesAtom(props.scopeId, ConnectionId.make(props.connection.id)),
  );
  const sourcesResult = useAtomValue(sourcesOptimisticAtom(props.scopeId));
  const sources = AsyncResult.isSuccess(sourcesResult)
    ? (sourcesResult.value as readonly LinkedSource[])
    : [];
  const allScopes = splitScopes(props.connection.oauthScope);
  const connectionShape = {
    id: props.connection.id,
    scopeId: props.connection.scopeId,
    identityLabel: props.connection.identityLabel,
  };
  return AsyncResult.match(usages, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => {
      const linkedSources = value
        .map((usage) => {
          const source = sources.find((candidate) => candidate.id === usage.ownerId);
          return {
            id: usage.ownerId,
            name: source?.name ?? usage.ownerName ?? usage.ownerId,
            kind: source?.kind ?? usage.pluginId,
            url: source?.url,
            connectionIds: source?.connectionIds,
          };
        })
        .filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index);
      if (!props.open) {
        if (linkedSources.length === 0) return null;
        const visible = linkedSources.slice(0, 2).map((source) => source.name);
        const hidden = linkedSources.length - visible.length;
        return (
          <CardStackEntryDescription className="mt-1 text-xs text-muted-foreground">
            Used by {visible.join(", ")}
            {hidden > 0 ? ` +${hidden} more` : ""}
          </CardStackEntryDescription>
        );
      }
      return (
        <div className="w-full space-y-4">
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-muted-foreground">Linked sources</div>
            {linkedSources.length === 0 ? (
              <div className="text-xs text-muted-foreground">No sources are using this yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {linkedSources.map((source) => (
                  <Link
                    key={source.id}
                    to="/sources/$namespace"
                    params={{ namespace: source.id }}
                    className="flex max-w-full items-center gap-2 rounded-md border border-border/60 bg-background/70 px-2 py-1.5 transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <SourceIconWithAccount
                      icon={sourcePresetIconUrl(source, sourcePlugins)}
                      sourceId={source.id}
                      url={source.url}
                      connection={connectionShape}
                      size="sm"
                    />
                    <span className="truncate text-xs font-medium text-foreground">
                      {source.name}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          {allScopes.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">Granted scopes</div>
              <div className="max-h-24 overflow-y-auto pr-1">
                <div className="flex flex-wrap gap-1.5">
                  {allScopes.map((scope) => (
                    <span
                      key={scope}
                      title={scope}
                      className="max-w-full truncate rounded border border-border/60 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {compactScope(scope)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

function ConnectionRow(props: {
  scopeId: ScopeId;
  connection: ConnectionListItem;
  scopeStack: readonly { readonly id: string; readonly name: string }[];
  onRemove: () => void;
}) {
  const { connection } = props;
  const doUpdateIdentity = useAtomSet(updateConnectionIdentity, { mode: "promiseExit" });
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [displayName, setDisplayName] = useState(connection.identityOverride?.displayName ?? "");
  const [email, setEmail] = useState(connection.identityOverride?.email ?? "");
  const [avatarUrl, setAvatarUrl] = useState(connection.identityOverride?.avatarUrl ?? "");
  const identityResult = useAtomValue(
    connectionIdentityAtom(ScopeId.make(connection.scopeId), ConnectionId.make(connection.id)),
  );
  const identity =
    AsyncResult.isSuccess(identityResult) && identityResult.value.status === "available"
      ? identityResult.value
      : null;
  const identityStatus =
    AsyncResult.isSuccess(identityResult) && identityResult.value.status !== "available"
      ? identityResult.value
      : null;
  const scopeLabel = connectionScopeLabel(connection.scopeId, props.scopeStack);
  const displayLabel =
    identity?.email ??
    identity?.name ??
    (connection.identityLabel && connection.identityLabel.length > 0
      ? connection.identityLabel
      : connection.id);
  const details = [displayProvider(connection.provider), scopeLabel];

  useEffect(() => {
    if (editingIdentity) return;
    setDisplayName(connection.identityOverride?.displayName ?? "");
    setEmail(connection.identityOverride?.email ?? "");
    setAvatarUrl(connection.identityOverride?.avatarUrl ?? "");
  }, [connection.identityOverride, editingIdentity]);

  const handleSaveIdentity = async () => {
    setSavingIdentity(true);
    const cleanDisplayName = displayName.trim();
    const cleanEmail = email.trim();
    const cleanAvatarUrl = avatarUrl.trim();
    const identityOverride =
      cleanDisplayName || cleanEmail || cleanAvatarUrl
        ? {
            displayName: cleanDisplayName || null,
            email: cleanEmail || null,
            avatarUrl: cleanAvatarUrl || null,
          }
        : null;
    const exit = await doUpdateIdentity({
      params: {
        scopeId: ScopeId.make(connection.scopeId),
        connectionId: ConnectionId.make(connection.id),
      },
      payload: { identityOverride },
      reactivityKeys: connectionWriteKeys,
    });
    setSavingIdentity(false);
    if (Exit.isFailure(exit)) {
      toast.error("Failed to update account info");
      return;
    }
    setEditingIdentity(false);
  };

  return (
    <>
      <CardStackEntry className="flex-wrap items-start">
        <CardStackEntryContent>
          <CardStackEntryTitle className="flex min-w-0 items-center gap-2">
            {identity?.picture ? (
              <img
                src={identity.picture}
                alt=""
                referrerPolicy="no-referrer"
                className="size-5 shrink-0 rounded-full"
              />
            ) : null}
            <span className="truncate">{displayLabel}</span>
          </CardStackEntryTitle>
          <CardStackEntryDescription className="text-xs text-muted-foreground">
            {details.join(" · ")}
          </CardStackEntryDescription>
          {identityStatus?.status === "reauth_required" ? (
            <CardStackEntryDescription className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {identityStatus.message ?? "Connection needs re-authentication"}
            </CardStackEntryDescription>
          ) : null}
        </CardStackEntryContent>
        <CardStackEntryActions className="self-start pt-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => setExpanded((value) => !value)}
          >
            Details
            <ChevronDownIcon
              className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
          <Badge variant="outline">{scopeLabel}</Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
              >
                <svg viewBox="0 0 16 16" className="size-3">
                  <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem className="text-sm" onClick={() => setEditingIdentity(true)}>
                Edit account info
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive text-sm"
                onClick={props.onRemove}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardStackEntryActions>
        <Suspense fallback={null}>
          <ConnectionDetails scopeId={props.scopeId} connection={connection} open={expanded} />
        </Suspense>
      </CardStackEntry>
      <Dialog open={editingIdentity} onOpenChange={setEditingIdentity}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Account info</DialogTitle>
            <DialogDescription>
              Override the account details shown for this connection.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <FieldLabel>Display name</FieldLabel>
              <Input
                value={displayName}
                onChange={(event) => setDisplayName((event.target as HTMLInputElement).value)}
                placeholder={identity?.name ?? connection.identityLabel ?? "Rhys Sullivan"}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Email</FieldLabel>
              <Input
                value={email}
                onChange={(event) => setEmail((event.target as HTMLInputElement).value)}
                placeholder={identity?.email ?? "rhys@example.com"}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Avatar URL</FieldLabel>
              <Input
                value={avatarUrl}
                onChange={(event) => setAvatarUrl((event.target as HTMLInputElement).value)}
                placeholder={identity?.picture ?? "https://example.com/avatar.png"}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingIdentity(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSaveIdentity()} disabled={savingIdentity}>
              {savingIdentity ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ConnectionsPage() {
  const scopeId = useScope();
  const scopeStack = useScopeStack();
  const connections = useAtomValue(connectionsOptimisticAtom(scopeId));
  const doRemove = useAtomSet(removeConnectionOptimistic(scopeId), { mode: "promiseExit" });

  const handleRemove = async (connection: { readonly id: string; readonly scopeId: ScopeId }) => {
    const exit = await doRemove({
      params: { scopeId: connection.scopeId, connectionId: ConnectionId.make(connection.id) },
      reactivityKeys: connectionWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit);
      if (Option.isSome(error) && isConnectionInUseError(error.value)) {
        const count = error.value.usageCount;
        toast.error(
          `Connection is used by ${count} ${count === 1 ? "source" : "sources"}. Detach it before removing it.`,
        );
      } else {
        toast.error("Failed to remove connection");
      }
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
              Connections
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Signed-in accounts your sources use to call their APIs. Remove a connection to revoke
              access and drop its tokens.
            </p>
          </div>
        </div>

        {AsyncResult.match(connections, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
              <p className="text-sm text-muted-foreground">Loading connections…</p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">Failed to load connections</p>
            </div>
          ),
          onSuccess: ({ value }) => (
            <CardStack>
              <CardStackHeader>Connections</CardStackHeader>
              <CardStackContent>
                {value.length === 0 ? (
                  <CardStackEntry>
                    <CardStackEntryContent>
                      <CardStackEntryDescription>
                        No signed-in accounts yet. Add an OAuth source and its sign-in will appear
                        here.
                      </CardStackEntryDescription>
                    </CardStackEntryContent>
                  </CardStackEntry>
                ) : (
                  value.map((c: ConnectionListItem) => (
                    <ConnectionRow
                      key={c.id}
                      scopeId={scopeId}
                      connection={c}
                      scopeStack={scopeStack}
                      onRemove={() => handleRemove({ id: c.id, scopeId: ScopeId.make(c.scopeId) })}
                    />
                  ))
                )}
              </CardStackContent>
            </CardStack>
          ),
        })}
      </div>
    </div>
  );
}
