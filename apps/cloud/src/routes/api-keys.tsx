import { useState } from "react";
import { Exit } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { createFileRoute } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { toast } from "sonner";
import { apiKeyWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { apiKeysAtom, createApiKey, revokeApiKey } from "../web/api-key-atoms";

export const Route = createFileRoute("/api-keys")({
  component: ApiKeysPage,
});

type ApiKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly obfuscatedValue: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
};

type CreatedKey = ApiKeySummary & {
  readonly value: string;
};

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

const defaultApiKeyName = (): string =>
  `API key ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date())}`;

function ApiKeysPage() {
  const result = useAtomValue(apiKeysAtom);
  const doCreate = useAtomSet(createApiKey, { mode: "promiseExit" });
  const doRevoke = useAtomSet(revokeApiKey, { mode: "promiseExit" });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const exit = await doCreate({
      payload: { name: trimmed },
      reactivityKeys: apiKeyWriteKeys,
    });
    setCreating(false);
    if (Exit.isSuccess(exit)) {
      setCreatedKey(exit.value);
      setName("");
      toast.success("API key created");
      return;
    }
    toast.error("Failed to create API key");
  };

  const handleRevoke = async (key: ApiKeySummary) => {
    setRevokingId(key.id);
    const exit = await doRevoke({
      params: { apiKeyId: key.id },
      reactivityKeys: apiKeyWriteKeys,
    });
    setRevokingId(null);
    if (Exit.isSuccess(exit)) {
      toast.success(`Revoked ${key.name}`);
      return;
    }
    toast.error("Failed to revoke API key");
  };

  const closeCreate = (open: boolean) => {
    setCreateOpen(open);
    if (!open) {
      setName("");
      setCreatedKey(null);
      setCreating(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-10 lg:px-8 lg:py-14">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-3xl tracking-tight text-foreground">API keys</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              User keys for accessing the Executor API and MCP endpoint from scripts and tools.
            </p>
            <div className="mt-4 flex max-w-2xl items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                Authorization: Bearer &lt;api-key&gt;
              </code>
              <CopyButton value="Authorization: Bearer <api-key>" />
            </div>
            <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
              API keys work as PATs and have full access to your account.
            </p>
          </div>
          <Button
            onClick={() => {
              setName(defaultApiKeyName());
              setCreateOpen(true);
            }}
            className="shrink-0"
          >
            <span aria-hidden="true">+</span>
            New key
          </Button>
        </div>

        {AsyncResult.match(result, {
          onInitial: () => (
            <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading API keys...
            </div>
          ),
          onFailure: () => (
            <div className="rounded-md border border-border bg-card p-6 text-sm text-destructive">
              Failed to load API keys
            </div>
          ),
          onSuccess: ({ value }) =>
            value.apiKeys.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-card p-8">
                <h2 className="text-base font-semibold text-foreground">No API keys</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Create a key and send it in the Authorization Bearer header.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-border bg-card">
                <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground md:grid-cols-[1.4fr_1fr_1fr_auto]">
                  <span>Name</span>
                  <span className="hidden md:block">Created</span>
                  <span className="hidden md:block">Last used</span>
                  <span className="text-right">Actions</span>
                </div>
                {value.apiKeys.map((key: ApiKeySummary) => (
                  <div
                    key={key.id}
                    className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_1fr_1fr_auto]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{key.name}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {key.obfuscatedValue}
                      </p>
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
                      onClick={() => handleRevoke(key)}
                      disabled={revokingId === key.id}
                      title={`Revoke ${key.name}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <span aria-hidden="true">×</span>
                    </Button>
                  </div>
                ))}
              </div>
            ),
        })}
      </div>

      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Create API key</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              The key will act as your user in the current organization.
            </DialogDescription>
          </DialogHeader>

          {createdKey ? (
            <div className="grid gap-4 py-3">
              <div className="grid gap-1.5">
                <Label className="text-sm font-medium text-foreground">New key</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={createdKey.value}
                    readOnly
                    className="font-mono text-xs"
                    data-ph-mask
                  />
                  <CopyButton value={createdKey.value} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-sm font-medium text-foreground">Bearer header</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={`Authorization: Bearer ${createdKey.value}`}
                    readOnly
                    className="font-mono text-xs"
                    data-ph-mask
                  />
                  <CopyButton value={`Authorization: Bearer ${createdKey.value}`} />
                </div>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                Send this value as a Bearer token. It is only shown once.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 py-3">
              <div className="grid gap-1.5">
                <Label htmlFor="api-key-name" className="text-sm font-medium text-foreground">
                  Name
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Local CLI"
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
        </DialogContent>
      </Dialog>
    </div>
  );
}
