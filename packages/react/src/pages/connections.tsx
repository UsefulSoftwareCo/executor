import { Suspense } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ConnectionId, ConnectionInUseError, ScopeId } from "@executor-js/sdk";
import { toast } from "sonner";

import {
  connectionUsagesAtom,
  connectionsOptimisticAtom,
  removeConnectionOptimistic,
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

const connectionScopeLabel = (
  scopeId: string,
  stack: readonly { readonly id: string; readonly name: string }[],
) => {
  const index = stack.findIndex((entry) => entry.id === scopeId);
  if (index === 0) return "Personal";
  if (index > 0) return stack[index]?.name ?? "Shared";
  return "Scoped";
};

// ---------------------------------------------------------------------------
// Used-by footer — same shape as the secrets page. Returns null when a
// connection isn't referenced anywhere so newly-created connections
// don't get a stray "Used by 0" line before any source binds to them.
// ---------------------------------------------------------------------------

function ConnectionUsageFooter(props: { scopeId: ScopeId; connectionId: ConnectionId }) {
  const usages = useAtomValue(connectionUsagesAtom(props.scopeId, props.connectionId));
  return AsyncResult.match(usages, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => {
      if (value.length === 0) return null;
      const labels = value
        .map((u) => u.ownerName ?? u.ownerId)
        .filter((s, i, a) => a.indexOf(s) === i);
      const visible = labels.slice(0, 3);
      const hidden = labels.length - visible.length;
      return (
        <CardStackEntryDescription className="mt-1 text-xs text-muted-foreground">
          Used by {visible.join(", ")}
          {hidden > 0 ? ` +${hidden} more` : ""}
        </CardStackEntryDescription>
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

function ConnectionRow(props: {
  scopeId: ScopeId;
  connection: {
    id: string;
    scopeId: string;
    provider: string;
    identityLabel: string | null;
  };
  scopeStack: readonly { readonly id: string; readonly name: string }[];
  onRemove: () => void;
}) {
  const { connection } = props;
  const scopeLabel = connectionScopeLabel(connection.scopeId, props.scopeStack);
  const displayLabel =
    connection.identityLabel && connection.identityLabel.length > 0
      ? connection.identityLabel
      : connection.id;

  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex items-center gap-2">
          <span className="truncate">{displayLabel}</span>
        </CardStackEntryTitle>
        <CardStackEntryDescription className="text-xs text-muted-foreground">
          {displayProvider(connection.provider)}
        </CardStackEntryDescription>
        <Suspense fallback={null}>
          <ConnectionUsageFooter
            scopeId={props.scopeId}
            connectionId={ConnectionId.make(connection.id)}
          />
        </Suspense>
      </CardStackEntryContent>
      <CardStackEntryActions>
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
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-sm"
              onClick={props.onRemove}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardStackEntryActions>
    </CardStackEntry>
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
                  value.map(
                    (c: {
                      readonly id: string;
                      readonly scopeId: string;
                      readonly provider: string;
                      readonly identityLabel: string | null;
                    }) => (
                      <ConnectionRow
                        key={c.id}
                        scopeId={scopeId}
                        connection={{
                          id: c.id,
                          scopeId: c.scopeId,
                          provider: c.provider,
                          identityLabel: c.identityLabel,
                        }}
                        scopeStack={scopeStack}
                        onRemove={() =>
                          handleRemove({ id: c.id, scopeId: ScopeId.make(c.scopeId) })
                        }
                      />
                    ),
                  )
                )}
              </CardStackContent>
            </CardStack>
          ),
        })}
      </div>
    </div>
  );
}
