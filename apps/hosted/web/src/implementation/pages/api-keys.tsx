import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Redacted } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import type { ApiKeySummary, CreatedApiKey } from "@executor-js/hosted-server/api-keys";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Card, CardContent } from "@executor-js/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@executor-js/ui/components/dialog";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import {
  apiKeysAtom,
  createApiKeyAtom,
  revokeApiKeyAtom,
  ApiKeyFailed,
} from "../../contracts/api-keys.ts";
import { OrganizationDetailsBoundary, useOrganization } from "../components/organization.tsx";
import { documentationUrl } from "../../contracts/documentation.ts";

const tokenDocsUrl = documentationUrl("api-keys/#personal-access-tokens");

const date = (value: string | null) =>
  value === null ? "Never" : new Date(value).toLocaleString();
const errorMessage = (cause: Cause.Cause<ApiKeyFailed>) => {
  const error = Cause.squash(cause);
  return error instanceof ApiKeyFailed ? error.message : "Could not update API keys. Try again.";
};

/** Personal tokens; the selected organization supplies only the example request URL. */
export function ApiKeysPage() {
  return (
    <OrganizationDetailsBoundary>
      <PersonalAccessTokens />
    </OrganizationDetailsBoundary>
  );
}
function PersonalAccessTokens() {
  const organization = useOrganization();
  useDocumentTitle(productTitle("API keys"));
  const [offset, setOffset] = useState(0);
  const query = apiKeysAtom(offset);
  const keys = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const createAtom = createApiKeyAtom;
  const create = useAtomSet(createAtom, { mode: "promiseExit" });
  const reset = useAtomSet(createAtom);
  const creating = useAtomValue(createAtom).waiting;
  const revokeAtom = revokeApiKeyAtom;
  const revoke = useAtomSet(revokeAtom, { mode: "promiseExit" });
  const revoking = useAtomValue(revokeAtom).waiting;
  const [form, setForm] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [created, setCreated] = useState<typeof CreatedApiKey.Type>();
  const [target, setTarget] = useState<ApiKeySummary>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const pending = creating || revoking;
  const empty = AsyncResult.isSuccess(keys) && keys.value.apiKeys.length === 0;
  const example = `curl '${window.location.origin}/api/organizations/${encodeURIComponent(organization.organization)}/inventory' \\\n  --header 'Authorization: Bearer <YOUR_API_KEY>'`;
  const mcpExample = JSON.stringify(
    {
      mcpServers: {
        executor: {
          type: "http",
          url: `${window.location.origin}/mcp`,
          headers: {
            Authorization: "Bearer <YOUR_PAT>",
            "X-Executor-Organization": organization.organization,
          },
        },
      },
    },
    null,
    2,
  );
  return (
    <PageFrame>
      <PageHeader title="API keys" description="Personal access tokens for scripts and agents.">
        {!empty && (
          <Button
            onClick={() => {
              setError(undefined);
              setForm(true);
            }}
            disabled={pending}
          >
            Create token
          </Button>
        )}
      </PageHeader>
      <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
        Tokens have your current permissions. Changes to your organization memberships and roles
        apply automatically. Tokens stay active when you sign out.
      </p>
      {error && !form && !target && !created && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <Card className={empty ? "border-0 py-0 shadow-none" : "py-0 shadow-none"}>
        <CardContent className="p-0">
          {!empty && (
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-medium">Your tokens</h2>
              <Button variant="ghost" size="sm" onClick={refresh} disabled={keys.waiting}>
                Refresh
              </Button>
            </div>
          )}
          {AsyncResult.isInitial(keys) ? (
            <p role="status" className="p-6 text-sm text-muted-foreground">
              Loading tokens…
            </p>
          ) : AsyncResult.isFailure(keys) ? (
            <div className="p-6">
              <p role="alert" className="mb-3 text-sm text-destructive">
                {errorMessage(keys.cause)}
              </p>
              <Button variant="outline" onClick={refresh}>
                Try again
              </Button>
            </div>
          ) : keys.value.apiKeys.length === 0 ? (
            <div className="p-6">
              <EmptyState
                heading="h3"
                title="No tokens yet"
                action={
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setError(undefined);
                      setForm(true);
                    }}
                  >
                    Create token
                  </Button>
                }
              >
                Create a separate token for each script so you can revoke access independently.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    {["Name", "Last used", "Expires", "Status", ""].map((label) => (
                      <th key={label} className="px-4 py-3 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keys.value.apiKeys.map((key) => {
                    const status = key.status;
                    return (
                      <tr key={key.id} className="border-b last:border-0">
                        <td className="min-w-44 px-4 py-4">
                          <div className="font-medium break-words">{key.name}</div>
                          <code className="text-xs text-muted-foreground">{key.start}…</code>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Created by you · {date(key.createdAt)}
                          </p>
                        </td>
                        <td className="px-4 py-4 text-xs">{date(key.lastRequest)}</td>
                        <td className="px-4 py-4 text-xs">{date(key.expiresAt)}</td>
                        <td className="px-4 py-4 text-xs">{status}</td>
                        <td className="px-4 py-4">
                          {status === "Active" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setTarget(key);
                                setError(undefined);
                              }}
                              disabled={pending}
                            >
                              Revoke<span className="sr-only"> {key.name}</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {AsyncResult.isSuccess(keys) && (offset > 0 || offset + 50 < keys.value.total) && (
            <div className="flex justify-end gap-2 border-t p-3">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(offset - 50)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={offset + 50 >= keys.value.total}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="mt-8 space-y-6">
        <div>
          <h2 className="text-sm font-medium">Connect an MCP client</h2>
          <p className="my-2 text-sm text-muted-foreground">
            Replace the placeholder with your token. This config targets {organization.name}.
          </p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs">
            <code>{mcpExample}</code>
          </pre>
        </div>
        <div>
          <h2 className="text-sm font-medium">Use the HTTP API</h2>
          <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs">
            <code>{example}</code>
          </pre>
        </div>
      </div>
      <Dialog
        open={form}
        onOpenChange={(open) => {
          if (!creating) setForm(open);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[540px]">
          <div className="space-y-2 pr-6">
            <DialogTitle>Create token</DialogTitle>
            <DialogDescription>
              This token has your current permissions in Executor.
            </DialogDescription>
          </div>
          <form
            className="space-y-6"
            onSubmit={async (event) => {
              event.preventDefault();
              if (creating) return;
              setError(undefined);
              const result = await create({
                name: name.trim(),
                ...(expiry
                  ? { expiresIn: Math.floor((new Date(expiry).getTime() - Date.now()) / 1000) }
                  : {}),
              });
              if (Exit.isFailure(result)) {
                setError(errorMessage(result.cause));
                refresh();
              } else {
                setCreated(result.value);
                setCopied(false);
                setShowKey(false);
                setForm(false);
                setName("");
                setExpiry("");
                setOffset(0);
                refresh();
              }
              reset(Atom.Reset);
            }}
          >
            <label className="block text-sm font-medium">
              Name
              <Input
                className="mt-2"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Nightly report"
                required
                maxLength={80}
                pattern=".*\S.*"
                disabled={creating}
              />
            </label>
            <label className="block text-sm font-medium">
              Expiry <span className="font-normal text-muted-foreground">(optional)</span>
              <Input
                className="mt-2"
                type="datetime-local"
                aria-label="Expires"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
                disabled={creating}
              />
              <span className="mt-1.5 block text-xs font-normal text-muted-foreground">
                Leave blank for a token that does not expire.
              </span>
            </label>
            <a
              href={tokenDocsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              About personal access tokens<span className="sr-only"> (opens in a new tab)</span>
            </a>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter className="border-t pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={creating}
                onClick={() => setForm(false)}
              >
                Cancel
              </Button>
              <Button loading={creating} disabled={creating || !name.trim()} type="submit">
                Create token
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={created !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setCreated(undefined);
            setError(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Save your token</DialogTitle>
          <DialogDescription>
            Copy this token now. You cannot view it again after closing this dialog.
          </DialogDescription>
          {created && (
            <>
              <Input
                type={showKey ? "text" : "password"}
                aria-label="New token"
                readOnly
                value={Redacted.value(created.key)}
                className="font-mono text-xs"
                autoComplete="off"
                data-private
              />
              <Button variant="ghost" size="sm" onClick={() => setShowKey(!showKey)}>
                {showKey ? "Hide key" : "Show key"}
              </Button>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreated(undefined);
                    setError(undefined);
                  }}
                >
                  Done
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(Redacted.value(created.key));
                      setCopied(true);
                      setError(undefined);
                    } catch {
                      setError("Could not copy. Select the key above and copy it manually.");
                    }
                  }}
                >
                  {copied ? "Copied" : "Copy token"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open && !revoking) setTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Revoke {target?.name}?</DialogTitle>
          <DialogDescription>
            New requests using this key will fail. Running requests may finish. Create and install a
            replacement first if an integration still needs access.
          </DialogDescription>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={revoking} onClick={() => setTarget(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={revoking}
              disabled={revoking}
              onClick={async () => {
                if (!target || revoking) return;
                const result = await revoke(target.id);
                if (Exit.isFailure(result)) setError(errorMessage(result.cause));
                else {
                  setTarget(undefined);
                  setError(undefined);
                  refresh();
                }
              }}
            >
              Revoke token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageFrame>
  );
}
