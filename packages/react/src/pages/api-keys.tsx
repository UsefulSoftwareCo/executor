import { useState, type ReactNode } from "react";
import { Cause, Exit, Option, Predicate } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { toast } from "sonner";
import type { ApiKeySummary as ApiKeySummarySchema } from "@executor-js/api";
import { apiKeyWriteKeys, orgApiKeyWriteKeys } from "../api/reactivity-keys";
import { trackEvent } from "../api/analytics";
import {
  apiKeysAtom,
  createApiKey,
  createOrgApiKey,
  orgApiKeysAtom,
  revokeApiKey,
  revokeOrgApiKey,
} from "../api/account-atoms";
import { useIsTenantAdmin } from "../multiplayer/use-admin-nav";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
import { CopyButton } from "../components/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";
import { Skeleton } from "../components/skeleton";
import { EmptyState } from "../components/empty-state";

// ---------------------------------------------------------------------------
// Shared API-keys page. Reads/writes the provider-neutral `/account/api-keys`
// surface, so it works identically on cloud (WorkOS) and self-host (Better
// Auth). API keys are how a user authenticates the Executor API + MCP endpoint
// from scripts/agents (Authorization: Bearer <key>).
//
// `orgKeysSection` is a host slot: the section component lives in this file
// (its contract is the shared account API), but only hosts that mint org keys
// mount it — cloud passes `<OrgApiKeysSection />`, self-host passes nothing
// because its provider refuses org keys (`/admin/*` there is gated on an
// owner/admin session instead).
// ---------------------------------------------------------------------------

type ApiKeySummary = typeof ApiKeySummarySchema.Type;

type CreatedKey = ApiKeySummary & { readonly value: string };

const formatDate = (value: string | null): string => {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
};

const defaultKeyName = (kind: string): string =>
  `${kind} ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date())}`;

/** The shared list markup — both key sections render the same columns. */
function KeyTable(props: {
  readonly keys: readonly ApiKeySummary[];
  readonly revokingId: string | null;
  readonly onRevoke: (key: ApiKeySummary) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground md:grid-cols-[1.4fr_1fr_1fr_auto]">
        <span>Name</span>
        <span className="hidden md:block">Created</span>
        <span className="hidden md:block">Last used</span>
        <span className="text-right">Actions</span>
      </div>
      {props.keys.map((key) => (
        <div
          key={key.id}
          className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_1fr_1fr_auto]"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{key.name}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{key.obfuscatedValue}</p>
          </div>
          <p className="hidden text-sm text-muted-foreground md:block">
            {formatDate(key.createdAt)}
          </p>
          <p className="hidden text-sm text-muted-foreground md:block">
            {formatDate(key.lastUsedAt)}
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => props.onRevoke(key)}
            disabled={props.revokingId === key.id}
            title={`Revoke ${key.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The one-time reveal of a freshly minted key's value + Bearer header. */
function CreatedKeyReveal(props: {
  readonly value: string;
  readonly onCopy: (kind: "value" | "bearer_header") => void;
}) {
  return (
    <div className="grid gap-4 py-3">
      <div className="grid gap-1.5">
        <Label className="text-sm font-medium text-foreground">New key</Label>
        <div className="flex items-center gap-2">
          <Input value={props.value} readOnly className="font-mono text-xs" data-ph-mask />
          <CopyButton value={props.value} onCopy={() => props.onCopy("value")} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-sm font-medium text-foreground">Bearer header</Label>
        <div className="flex items-center gap-2">
          <Input
            value={`Authorization: Bearer ${props.value}`}
            readOnly
            className="font-mono text-xs"
            data-ph-mask
          />
          <CopyButton
            value={`Authorization: Bearer ${props.value}`}
            onCopy={() => props.onCopy("bearer_header")}
          />
        </div>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        Send this value as a Bearer token. It is only shown once.
      </p>
    </div>
  );
}

/**
 * The create dialog's state-bearing body, shared by both key kinds. Remounted
 * per open via a key bump (self-contained modal): form and in-flight state are
 * destroyed on close instead of hand-reset, while the Dialog shell stays
 * mounted so Radix's exit animation keeps its last frame. A create resolving
 * after close therefore lands on an unmounted component instead of wedging the
 * next open on the previous key's reveal.
 */
function CreateKeyDialogBody(props: {
  readonly title: string;
  readonly description: string;
  readonly defaultName: string;
  readonly placeholder: string;
  readonly onCreate: (name: string) => Promise<CreatedKey | null>;
  readonly onCopy: (kind: "value" | "bearer_header") => void;
}) {
  const [name, setName] = useState(props.defaultName);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const created = await props.onCreate(trimmed);
    setCreating(false);
    if (created) setCreatedKey(created);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{props.title}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          {props.description}
        </DialogDescription>
      </DialogHeader>

      {createdKey ? (
        <CreatedKeyReveal value={createdKey.value} onCopy={props.onCopy} />
      ) : (
        <div className="grid gap-4 py-3">
          <div className="grid gap-1.5">
            <Label htmlFor="create-key-name" className="text-sm font-medium text-foreground">
              Name
            </Label>
            <Input
              id="create-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={props.placeholder}
              maxLength={80}
              autoFocus
            />
          </div>
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Close</Button>
        </DialogClose>
        {!createdKey && (
          <Button onClick={handleCreate} disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create key"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

export function ApiKeysPage(props: { readonly orgKeysSection?: ReactNode }) {
  useExecutorDocumentTitle("API keys");
  const result = useAtomValue(apiKeysAtom);
  const refreshApiKeys = useAtomRefresh(apiKeysAtom);
  const doCreate = useAtomSet(createApiKey, { mode: "promiseExit" });
  const doRevoke = useAtomSet(revokeApiKey, { mode: "promiseExit" });
  const [createOpen, setCreateOpen] = useState(false);
  // Bumped per open so the dialog body remounts with fresh state; the shell
  // stays mounted for Radix's exit animation (see CreateKeyDialogBody).
  const [openCount, setOpenCount] = useState(0);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleCreate = async (name: string): Promise<CreatedKey | null> => {
    const exit = await doCreate({ payload: { name }, reactivityKeys: apiKeyWriteKeys });
    trackEvent("api_key_created", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success("API key created");
      return exit.value;
    }
    toast.error("Failed to create API key");
    return null;
  };

  const handleRevoke = async (key: ApiKeySummary) => {
    setRevokingId(key.id);
    const exit = await doRevoke({ params: { apiKeyId: key.id }, reactivityKeys: apiKeyWriteKeys });
    setRevokingId(null);
    trackEvent("api_key_revoked", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success(`Revoked ${key.name}`);
      return;
    }
    toast.error("Failed to revoke API key");
  };

  return (
    <PageContainer>
      <PageHeader
        title="API keys"
        description="Keys for accessing the Executor API and MCP endpoint from scripts and tools."
        actions={
          <Button
            onClick={() => {
              setOpenCount((count) => count + 1);
              setCreateOpen(true);
            }}
          >
            <span aria-hidden="true">+</span>
            New key
          </Button>
        }
      >
        <div className="mt-4 flex max-w-2xl items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            Authorization: Bearer &lt;api-key&gt;
          </code>
          <CopyButton value="Authorization: Bearer <api-key>" />
        </div>
      </PageHeader>

      <section>
        <h2 className="text-sm font-medium text-foreground">Personal keys</h2>
        <p className="mb-4 mt-0.5 max-w-2xl text-sm text-muted-foreground">
          Personal keys work like personal access tokens: they act as you, in this organization,
          with full access to your own account.
        </p>

        {isAsyncResultLoading(result) ? (
          <KeyTableSkeleton />
        ) : (
          AsyncResult.match(result, {
            onInitial: () => <KeyTableSkeleton />,
            onFailure: () => (
              <ErrorState message="Failed to load API keys" onRetry={refreshApiKeys} />
            ),
            onSuccess: ({ value }) =>
              value.apiKeys.length === 0 ? (
                <EmptyState
                  title="No API keys"
                  description="Create a key and send it in the Authorization Bearer header."
                  action={<Button onClick={() => setCreateOpen(true)}>Create a key</Button>}
                />
              ) : (
                <KeyTable keys={value.apiKeys} revokingId={revokingId} onRevoke={handleRevoke} />
              ),
          })
        )}
      </section>

      {props.orgKeysSection}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <CreateKeyDialogBody
            key={openCount}
            title="Create API key"
            description="The key will act as your user in the current organization."
            defaultName={defaultKeyName("API key")}
            placeholder="Local CLI"
            onCreate={handleCreate}
            onCopy={(kind) => trackEvent("api_key_copied", { kind })}
          />
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Organization keys — the admin-only, org-owned credentials for the read-only
// admin API (`/api/admin/*`). A separate section rather than rows in the table
// above because the two key kinds answer different questions: a personal key
// acts AS the member who minted it on the product plane; an org key has no
// member behind it and reads the whole tenant.
//
// The admin gate here only HIDES the section — the server enforces the real
// one (403 for a plain member), and that refusal renders as an explicit
// denial below, never as a retryable failure.
// ---------------------------------------------------------------------------

/** 403 (or no-org) from the org-key surface: the caller is not an active admin
 *  of this org. A denial, not a transient failure — the client-side role gate
 *  can disagree with the server (role change inside the member list's TTL;
 *  `owner` accepted client-side where cloud requires `admin`), and offering
 *  Retry on a refusal would only re-fail forever. */
const isOrgKeysAccessDenied = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      Predicate.isTagged(error, "AccountForbidden") ||
      Predicate.isTagged(error, "AccountNoOrganization"),
  });

export function OrgApiKeysSection() {
  // Gate BEFORE mounting the body: `orgApiKeysAtom` starts its fetch when the
  // reading component mounts, and for a plain member that request is a
  // guaranteed 403. Fail-closed like the admin nav — while the member list is
  // loading, show nothing rather than a section that will refuse.
  const isAdmin = useIsTenantAdmin();
  return isAdmin ? <OrgApiKeysSectionBody /> : null;
}

function OrgApiKeysSectionBody() {
  const result = useAtomValue(orgApiKeysAtom);
  const refresh = useAtomRefresh(orgApiKeysAtom);
  const doCreate = useAtomSet(createOrgApiKey, { mode: "promiseExit" });
  const doRevoke = useAtomSet(revokeOrgApiKey, { mode: "promiseExit" });
  const [createOpen, setCreateOpen] = useState(false);
  // Same remount-per-open discipline as the personal dialog above.
  const [openCount, setOpenCount] = useState(0);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKeySummary | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleCreate = async (name: string): Promise<CreatedKey | null> => {
    const exit = await doCreate({ payload: { name }, reactivityKeys: orgApiKeyWriteKeys });
    trackEvent("org_api_key_created", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success("Organization key created");
      return exit.value;
    }
    toast.error("Failed to create organization key");
    return null;
  };

  const handleRevoke = async (key: ApiKeySummary) => {
    setConfirmRevoke(null);
    setRevokingId(key.id);
    const exit = await doRevoke({
      params: { apiKeyId: key.id },
      reactivityKeys: orgApiKeyWriteKeys,
    });
    setRevokingId(null);
    trackEvent("org_api_key_revoked", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success(`Revoked ${key.name}`);
      return;
    }
    toast.error("Failed to revoke organization key");
  };

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Organization keys</h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Read-only keys owned by the organization, not a member. They authenticate the admin API
            (who are my users, what have they connected) and cannot act as anyone or write anything.
            Admins only.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setOpenCount((count) => count + 1);
            setCreateOpen(true);
          }}
        >
          <span aria-hidden="true">+</span>
          New org key
        </Button>
      </div>

      {isAsyncResultLoading(result) ? (
        <KeyTableSkeleton />
      ) : (
        AsyncResult.match(result, {
          onInitial: () => <KeyTableSkeleton />,
          onFailure: ({ cause }) =>
            isOrgKeysAccessDenied(cause) ? (
              <div className="rounded-md border border-border bg-card p-8">
                <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Admin only
                </p>
                <h3 className="mt-2 text-base font-semibold text-foreground">
                  You don&apos;t have access to this organization&apos;s keys
                </h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Managing organization keys requires an active admin role. Ask an admin of this
                  organization if you need one.
                </p>
              </div>
            ) : (
              <ErrorState message="Failed to load organization keys" onRetry={refresh} />
            ),
          onSuccess: ({ value }) =>
            value.apiKeys.length === 0 ? (
              <EmptyState
                title="No organization keys"
                description="Create one to call the admin API from your backend."
                action={
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    Create an organization key
                  </Button>
                }
              />
            ) : (
              <KeyTable
                keys={value.apiKeys}
                revokingId={revokingId}
                onRevoke={(key) => setConfirmRevoke(key)}
              />
            ),
        })
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <CreateKeyDialogBody
            key={openCount}
            title="Create organization key"
            description="The key will belong to the organization itself, not to you. It grants read-only access to the admin API across the whole organization."
            defaultName={defaultKeyName("Organization key")}
            placeholder="Backend admin reader"
            onCreate={handleCreate}
            onCopy={(kind) => trackEvent("org_api_key_copied", { kind })}
          />
        </DialogContent>
      </Dialog>

      {/* Revoking an org key breaks every backend using it, so it is the one
          revoke on this page that asks first. */}
      <Dialog
        open={confirmRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRevoke(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Revoke organization key</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              {confirmRevoke
                ? `Revoke ${confirmRevoke.name}? Anything authenticating with it loses admin API access immediately. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmRevoke) void handleRevoke(confirmRevoke);
              }}
            >
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function KeyTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 md:grid-cols-[1.4fr_1fr_1fr_auto]">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="hidden h-3 w-16 md:block" />
        <Skeleton className="hidden h-3 w-16 md:block" />
        <Skeleton className="ml-auto h-3 w-14" />
      </div>
      {Array.from({ length: 2 }).map((_, index) => (
        <div
          key={index}
          className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_1fr_1fr_auto]"
        >
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="hidden h-3 w-20 md:block" />
          <Skeleton className="hidden h-3 w-20 md:block" />
          <Skeleton className="ml-auto size-7 rounded-md" />
        </div>
      ))}
    </div>
  );
}
