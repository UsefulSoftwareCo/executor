import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Exit } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { toast } from "@executor-js/react/components/sonner";

import { apiKeysAtom, revokeApiKey } from "@executor-js/react/api/account-atoms";
import { apiKeyWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { ErrorState } from "@executor-js/react/components/error-state";
import { PageContainer, PageHeader } from "@executor-js/react/components/page";
import { useExecutorDocumentTitle } from "@executor-js/react/lib/document-title";

import {
  connectedClientsAtom,
  connectedClientsWriteKeys,
  revokeOAuthClient,
  revokeSession,
} from "../../access-atoms";

export const Route = createFileRoute("/{-$orgSlug}/connected-clients")({
  component: ConnectedClientsPage,
});

// ---------------------------------------------------------------------------
// Connected clients — everything that can act as you on this instance, in one
// place, each with a way to cut it off:
//
//   - MCP clients that connected over OAuth (Claude Code, Cursor, Codex, …)
//   - personal API keys (the shared /account surface; created on API keys)
//   - browser sessions
//
// Every revoke asks first: each one signs something out immediately, and an
// MCP client or a script only finds out on its next call.
// ---------------------------------------------------------------------------

const formatWhen = (epochMs: number | null): string => {
  if (epochMs === null || epochMs <= 0) return "Never";
  const seconds = Math.round((Date.now() - epochMs) / 1000);
  if (seconds < 0) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(epochMs);
  }
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 30 * 86_400) return `${Math.round(seconds / 86_400)} days ago`;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(epochMs);
};

const fromIso = (value: string | null): number | null => {
  if (value === null) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/** Enough of a user agent to recognise the device — not a fingerprint. */
const describeUserAgent = (userAgent: string | null): string => {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
};

interface PendingRevoke {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly run: () => Promise<boolean>;
}

function ConnectedClientsPage() {
  useExecutorDocumentTitle("Connected clients");
  const [pending, setPending] = useState<PendingRevoke | null>(null);

  return (
    <PageContainer>
      <PageHeader
        title="Connected clients"
        description="Everything that can act as you on this instance: MCP clients, API keys and browser sessions. Revoking one signs it out immediately."
      />
      <div className="flex flex-col gap-10">
        <OAuthClientsSection onRevoke={setPending} />
        <ApiKeysSection onRevoke={setPending} />
        <SessionsSection onRevoke={setPending} />
      </div>
      <ConfirmRevokeDialog pending={pending} onClose={() => setPending(null)} />
    </PageContainer>
  );
}

function Section(props: {
  readonly title: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
      <p className="mb-4 mt-0.5 max-w-2xl text-sm text-muted-foreground">{props.description}</p>
      {props.children}
    </section>
  );
}

function Notice(props: { readonly children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
      {props.children}
    </div>
  );
}

const ROW =
  "grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_1fr_1fr_auto]";
const HEAD =
  "grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground md:grid-cols-[1.4fr_1fr_1fr_auto]";

function Rows(props: { readonly columns: readonly string[]; readonly children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className={HEAD}>
        <span>{props.columns[0]}</span>
        <span className="hidden md:block">{props.columns[1]}</span>
        <span className="hidden md:block">{props.columns[2]}</span>
        <span className="text-right">Actions</span>
      </div>
      {props.children}
    </div>
  );
}

function RevokeButton(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={props.onClick}
      className="text-muted-foreground hover:text-destructive"
    >
      {props.label}
    </Button>
  );
}

// ── MCP clients ─────────────────────────────────────────────────────────────

function OAuthClientsSection(props: { readonly onRevoke: (pending: PendingRevoke) => void }) {
  const result = useAtomValue(connectedClientsAtom);
  const refresh = useAtomRefresh(connectedClientsAtom);
  const doRevoke = useAtomSet(revokeOAuthClient, { mode: "promiseExit" });

  return (
    <Section
      title="MCP clients"
      description="Agents that connected over OAuth. Revoking one signs it out at once — including a session it has open — and it has to be approved again before it can call a tool."
    >
      {AsyncResult.match(result, {
        onInitial: () => <Notice>Loading clients…</Notice>,
        onFailure: () => <ErrorState message="Failed to load MCP clients" onRetry={refresh} />,
        onSuccess: ({ value }) =>
          value.oauthClients.length === 0 ? (
            <Notice>No MCP client has connected with your account yet.</Notice>
          ) : (
            <Rows columns={["Client", "Last sign-in", "Status"]}>
              {value.oauthClients.map((client) => {
                const name = client.name ?? "Unnamed client";
                return (
                  <div key={client.clientId} className={ROW}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{name}</p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {client.clientId}
                      </p>
                    </div>
                    <p className="hidden text-sm text-muted-foreground md:block">
                      {formatWhen(client.lastAuthorizedAt)}
                    </p>
                    <div className="hidden md:block">
                      {client.activeTokens > 0 ? (
                        <Badge variant="secondary">Connected</Badge>
                      ) : (
                        <Badge variant="outline">Signed out</Badge>
                      )}
                    </div>
                    <RevokeButton
                      label="Revoke"
                      onClick={() =>
                        props.onRevoke({
                          title: "Revoke MCP client",
                          description: `Revoke ${name}? It is signed out immediately, including any session it has open, and must be approved again before it can call a tool.`,
                          action: "Revoke client",
                          run: async () => {
                            const exit = await doRevoke({
                              params: { clientId: client.clientId },
                              reactivityKeys: connectedClientsWriteKeys,
                            });
                            return Exit.isSuccess(exit);
                          },
                        })
                      }
                    />
                  </div>
                );
              })}
            </Rows>
          ),
      })}
    </Section>
  );
}

// ── API keys ────────────────────────────────────────────────────────────────

function ApiKeysSection(props: { readonly onRevoke: (pending: PendingRevoke) => void }) {
  const result = useAtomValue(apiKeysAtom);
  const refresh = useAtomRefresh(apiKeysAtom);
  const doRevoke = useAtomSet(revokeApiKey, { mode: "promiseExit" });

  return (
    <Section
      title="API keys"
      description={
        <>
          Personal keys scripts and agents use as a bearer token. Create new ones on the{" "}
          <Link to="/{-$orgSlug}/api-keys" className="underline underline-offset-2">
            API keys
          </Link>{" "}
          page.
        </>
      }
    >
      {AsyncResult.match(result, {
        onInitial: () => <Notice>Loading API keys…</Notice>,
        onFailure: () => <ErrorState message="Failed to load API keys" onRetry={refresh} />,
        onSuccess: ({ value }) =>
          value.apiKeys.length === 0 ? (
            <Notice>You have no API keys.</Notice>
          ) : (
            <Rows columns={["Key", "Created", "Last used"]}>
              {value.apiKeys.map((key) => (
                <div key={key.id} className={ROW}>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{key.name}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {key.obfuscatedValue}
                    </p>
                  </div>
                  <p className="hidden text-sm text-muted-foreground md:block">
                    {formatWhen(fromIso(key.createdAt))}
                  </p>
                  <p className="hidden text-sm text-muted-foreground md:block">
                    {formatWhen(fromIso(key.lastUsedAt))}
                  </p>
                  <RevokeButton
                    label="Revoke"
                    onClick={() =>
                      props.onRevoke({
                        title: "Revoke API key",
                        description: `Revoke ${key.name}? Any script or agent authenticating with it loses access immediately. This cannot be undone.`,
                        action: "Revoke key",
                        run: async () => {
                          const exit = await doRevoke({
                            params: { apiKeyId: key.id },
                            reactivityKeys: apiKeyWriteKeys,
                          });
                          return Exit.isSuccess(exit);
                        },
                      })
                    }
                  />
                </div>
              ))}
            </Rows>
          ),
      })}
    </Section>
  );
}

// ── Browser sessions ────────────────────────────────────────────────────────

function SessionsSection(props: { readonly onRevoke: (pending: PendingRevoke) => void }) {
  const result = useAtomValue(connectedClientsAtom);
  const refresh = useAtomRefresh(connectedClientsAtom);
  const doRevoke = useAtomSet(revokeSession, { mode: "promiseExit" });

  return (
    <Section
      title="Browser sessions"
      description="Where you are signed in to this console. Signing a session out ends it on that device; this browser stays signed in."
    >
      {AsyncResult.match(result, {
        onInitial: () => <Notice>Loading sessions…</Notice>,
        onFailure: () => <ErrorState message="Failed to load sessions" onRetry={refresh} />,
        onSuccess: ({ value }) => (
          <Rows columns={["Device", "Last active", "Expires"]}>
            {value.sessions.map((session) => {
              const device = describeUserAgent(session.userAgent);
              return (
                <div key={session.id} className={ROW}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
                      {device}
                      {session.current ? <Badge variant="secondary">This browser</Badge> : null}
                    </p>
                    {session.ipAddress ? (
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {session.ipAddress}
                      </p>
                    ) : null}
                  </div>
                  <p className="hidden text-sm text-muted-foreground md:block">
                    {formatWhen(session.lastActiveAt)}
                  </p>
                  <p className="hidden text-sm text-muted-foreground md:block">
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                    }).format(session.expiresAt)}
                  </p>
                  {session.current ? (
                    <span className="px-3 text-right text-xs text-muted-foreground">—</span>
                  ) : (
                    <RevokeButton
                      label="Sign out"
                      onClick={() =>
                        props.onRevoke({
                          title: "Sign out session",
                          description: `Sign out ${device}? That browser has to sign in again.`,
                          action: "Sign out",
                          run: async () => {
                            const exit = await doRevoke({
                              params: { sessionId: session.id },
                              reactivityKeys: connectedClientsWriteKeys,
                            });
                            return Exit.isSuccess(exit);
                          },
                        })
                      }
                    />
                  )}
                </div>
              );
            })}
          </Rows>
        ),
      })}
    </Section>
  );
}

// ── Confirmation ────────────────────────────────────────────────────────────

function ConfirmRevokeDialog(props: {
  readonly pending: PendingRevoke | null;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { pending } = props;
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{pending?.title ?? ""}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {pending?.description ?? ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (!pending) return;
              setBusy(true);
              void pending.run().then((ok) => {
                setBusy(false);
                props.onClose();
                if (ok) toast.success("Revoked");
                else toast.error("Could not revoke — try again");
              });
            }}
          >
            {pending?.action ?? "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
