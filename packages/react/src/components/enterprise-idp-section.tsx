import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { OAuthClientSlug, type OAuthClientSummary, type Owner } from "@executor-js/sdk/shared";
import { toast } from "sonner";

import {
  createOAuthClientOptimistic,
  oauthClientsOptimisticAtom,
  removeOAuthClientOptimistic,
} from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { oauthClientWriteKeys } from "../api/reactivity-keys";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Input } from "./input";
import { Label } from "./label";

// ---------------------------------------------------------------------------
// Enterprise Identity Provider — the organization-level registration behind MCP
// Enterprise-Managed Authorization.
//
// An organization has exactly ONE enterprise identity provider, so this is not
// a list: it is a single registration under a reserved workspace-owned slug.
// What is registered is the client's OAuth app AT THE IdP (draft §5) — the
// relationship that authenticates the RFC 8693 exchange that mints an ID-JAG.
// It is a DIFFERENT registration from the per-server app at each MCP server's
// Resource Authorization Server, which is why an admin does this once here and
// then points individual servers at it.
//
// This is a shared component but not a shared page: only hosts that HAVE an
// organization admin surface compose it (cloud does, from its org page). The
// admin gate is the composing host's, because who counts as an admin is the
// host's model, not this component's.
// ---------------------------------------------------------------------------

/** The reserved `(owner, slug)` the organization's identity-provider app is
 *  registered under. Fixed rather than user-entered because the whole point is
 *  that servers can name it without an admin re-typing a slug, and because
 *  `oauth.createClient` upserts by `(owner, slug)` — so editing the provider is
 *  re-registering it under the same identity. */
export const ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG = OAuthClientSlug.make(
  "enterprise-identity-provider",
);

/** The organization owns it: every member's connections authorize through the
 *  same registration, which is what makes it an enterprise control. */
export const ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER: Owner = "org";

/** The organization's registered identity provider, or null when none is
 *  registered. Matched on the reserved `(owner, slug)` — never on a URL or a
 *  name, which an admin can change. */
export const findEnterpriseIdentityProvider = (
  clients: readonly OAuthClientSummary[],
): OAuthClientSummary | null =>
  clients.find(
    (client) =>
      client.owner === ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER &&
      String(client.slug) === String(ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG),
  ) ?? null;

/** Registering the provider needs the token endpoint the RFC 8693 exchange is
 *  POSTed to and the client id it authenticates as. The secret is optional: an
 *  IdP may treat the client as public. */
export const canSubmitEnterpriseIdentityProvider = (input: {
  readonly submitting: boolean;
  readonly tokenUrl: string;
  readonly clientId: string;
}): boolean =>
  !input.submitting && input.tokenUrl.trim().length > 0 && input.clientId.trim().length > 0;

/** The `oauth.createClient` payload for the organization's identity provider.
 *
 *  `authorizationUrl` is empty by construction and that is not an omission: the
 *  enterprise-managed chain never runs a browser redirect through this
 *  registration. It exchanges an assertion the user already holds at the token
 *  endpoint (draft §4.3), so there is no authorization endpoint to record — and
 *  inventing one would claim a flow this app does not run. */
export const enterpriseIdentityProviderPayload = (input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) => ({
  owner: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
  slug: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG,
  authorizationUrl: "",
  tokenUrl: input.tokenUrl.trim(),
  grant: "authorization_code" as const,
  clientId: input.clientId.trim(),
  clientSecret: input.clientSecret.trim(),
  // Not registered from any one integration's dialog: it backs every
  // enterprise-managed server in the workspace.
  originIntegration: null,
});

// ---------------------------------------------------------------------------
// The registration dialog. Self-contained: its form state lives here and dies
// with it, so re-opening after a cancel never resurfaces a half-typed secret.
// ---------------------------------------------------------------------------

function EnterpriseIdentityProviderDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The current registration when editing; null when registering the first
   *  one. The secret is never returned by the server, so it is always retyped. */
  readonly current: OAuthClientSummary | null;
}) {
  const { current } = props;
  const [tokenUrl, setTokenUrl] = useState(current === null ? "" : current.tokenUrl);
  const [clientId, setClientId] = useState(current === null ? "" : current.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const doCreate = useAtomSet(createOAuthClientOptimistic, { mode: "promiseExit" });

  const canSubmit = canSubmitEnterpriseIdentityProvider({ submitting, tokenUrl, clientId });

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const exit = await doCreate({
      payload: enterpriseIdentityProviderPayload({ tokenUrl, clientId, clientSecret }),
      reactivityKeys: oauthClientWriteKeys,
    });
    trackEvent("oauth_client_registered", {
      owner: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
      grant: "authorization_code",
      via_dcr: false,
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      setSubmitting(false);
      toast.error("Couldn't save the identity provider. Check the token URL, then retry.");
      return;
    }
    toast.success(current === null ? "Identity provider registered" : "Identity provider updated");
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next: boolean) => {
        if (submitting) return;
        props.onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {current === null ? "Register Identity Provider" : "Edit Identity Provider"}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Executor exchanges each member&apos;s single sign-on assertion at this endpoint for a
            grant naming one MCP server. Your identity provider decides which members may reach
            which servers.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="ema-idp-token-url" className="text-xs text-muted-foreground">
              Token URL
            </Label>
            <Input
              id="ema-idp-token-url"
              autoComplete="off"
              placeholder="https://example.okta.com/oauth2/default/v1/token"
              value={tokenUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTokenUrl(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ema-idp-client-id" className="text-xs text-muted-foreground">
              Client ID
            </Label>
            <Input
              id="ema-idp-client-id"
              autoComplete="off"
              placeholder="client id"
              value={clientId}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ema-idp-client-secret" className="text-xs text-muted-foreground">
              Client Secret
              <span className="font-normal text-muted-foreground/70">
                optional for public clients
              </span>
            </Label>
            <Input
              id="ema-idp-client-secret"
              type="password"
              autoComplete="new-password"
              placeholder={current === null ? "optional client secret" : "re-enter to change"}
              value={clientSecret}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSecret(e.target.value)}
              className="font-mono text-sm"
              data-ph-block
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? "Saving…" : current === null ? "Register Provider" : "Save Provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EnterpriseIdentityProviderSection() {
  const clientsResult = useAtomValue(oauthClientsOptimisticAtom);
  const doRemove = useAtomSet(removeOAuthClientOptimistic, { mode: "promiseExit" });
  const [dialogOpen, setDialogOpen] = useState(false);

  const provider = AsyncResult.isSuccess(clientsResult)
    ? findEnterpriseIdentityProvider(clientsResult.value)
    : null;

  const handleRemove = async () => {
    const exit = await doRemove({
      params: { slug: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG },
      payload: { owner: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER },
      reactivityKeys: oauthClientWriteKeys,
    });
    trackEvent("oauth_client_removed", { owner: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? "Identity provider removed" : "Failed to remove identity provider",
    );
  };

  return (
    <section className="mb-2">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">Enterprise Identity Provider</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Register the app Executor uses at your identity provider. MCP servers pointed at it
            connect through your organization instead of asking each member for consent.
          </p>
        </div>
        {provider === null ? (
          <Button size="sm" className="ml-4 min-w-32 shrink-0" onClick={() => setDialogOpen(true)}>
            Register Provider
          </Button>
        ) : null}
      </div>

      {AsyncResult.match(clientsResult, {
        onInitial: () => <div className="h-16 animate-pulse rounded-lg bg-muted/50" />,
        onFailure: () => (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-sm text-destructive">Failed to load the identity provider</p>
          </div>
        ),
        onSuccess: () =>
          provider === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No identity provider yet. Register one so MCP servers can authorize members through
              your organization.
            </p>
          ) : (
            <div className="rounded-lg border border-border">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p
                      id="ema-idp-token-url-value"
                      className="truncate font-mono text-sm text-foreground"
                    >
                      {provider.tokenUrl}
                    </p>
                    {/* Grayscale by design: status is a word plus tone, never a
                        hue (see design.md, Status and semantics). */}
                    <Badge className="shrink-0 bg-muted text-foreground">Registered</Badge>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {provider.clientId}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Identity provider actions"
                      >
                        <svg viewBox="0 0 16 16" className="size-3">
                          <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                          <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                        </svg>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem className="text-sm" onClick={() => setDialogOpen(true)}>
                        Edit Provider
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-sm text-destructive focus:text-destructive"
                        onClick={() => void handleRemove()}
                      >
                        Remove Provider
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <div className="border-t border-border px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  Members never see a consent screen for servers pointed at this provider, and
                  access is revoked at the provider, not here.
                </p>
              </div>
            </div>
          ),
      })}

      {/* Mounted only while open so the form — including a typed secret — is
          created and destroyed with the dialog. */}
      {dialogOpen ? (
        <EnterpriseIdentityProviderDialog open onOpenChange={setDialogOpen} current={provider} />
      ) : null}
    </section>
  );
}
