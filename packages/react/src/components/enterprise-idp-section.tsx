import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import {
  OAuthClientSlug,
  type EnterpriseIdentityProviderDescriptor,
  type OAuthClientSummary,
  type Owner,
} from "@executor-js/sdk/shared";
import { toast } from "sonner";

import {
  createOAuthClientOptimistic,
  oauthClientsOptimisticAtom,
  probeOAuth,
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

/** The descriptor a managed server points at — the shape an MCP server's
 *  `enterpriseIdentityProvider` declaration and `oauth.start`'s `enterprise`
 *  input both speak. Derived from the reserved identity, never typed by hand. */
export const ENTERPRISE_IDENTITY_PROVIDER_DESCRIPTOR: EnterpriseIdentityProviderDescriptor = {
  client: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG,
  clientOwner: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
};

/** Registering the provider needs the issuer to discover endpoints from and the
 *  client id the exchange authenticates as. The secret is optional: an identity
 *  provider may treat the registration as a public client. */
export const canSubmitEnterpriseIdentityProvider = (input: {
  readonly submitting: boolean;
  readonly issuerUrl: string;
  readonly clientId: string;
}): boolean =>
  !input.submitting && input.issuerUrl.trim().length > 0 && input.clientId.trim().length > 0;

/** The `oauth.createClient` payload for the organization's identity provider.
 *
 *  BOTH endpoints are recorded, and the authorization endpoint is the one worth
 *  explaining. The RFC 8693 exchange that mints an ID-JAG only ever touches the
 *  token endpoint — but the exchange needs a subject token ISSUED BY THIS
 *  PROVIDER and audienced to THIS client, and a WorkOS-brokered login does not
 *  produce one: there, WorkOS is the client at the customer's identity
 *  provider, and what executor holds is a WorkOS token. Closing that gap needs
 *  one authorization-code hop against this registration — the member's "link
 *  your work identity" step — and that hop needs an authorize endpoint. */
export const enterpriseIdentityProviderPayload = (input: {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) => ({
  owner: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
  slug: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG,
  authorizationUrl: input.authorizationUrl.trim(),
  tokenUrl: input.tokenUrl.trim(),
  grant: "authorization_code" as const,
  clientId: input.clientId.trim(),
  clientSecret: input.clientSecret.trim(),
  // Not registered from any one integration's dialog: it backs every
  // enterprise-managed server in the workspace.
  originIntegration: null,
});

/**
 * The organization's identity-provider pointer, or null when none is
 * registered.
 *
 * The pointer, deliberately, and not the registration: a server declaration and
 * a connect request both need to NAME the provider, and neither has any
 * business holding its endpoints or its client id.
 */
export function useEnterpriseIdentityProviderDescriptor(): EnterpriseIdentityProviderDescriptor | null {
  const clientsResult = useAtomValue(oauthClientsOptimisticAtom);
  return AsyncResult.isSuccess(clientsResult) &&
    findEnterpriseIdentityProvider(clientsResult.value) !== null
    ? ENTERPRISE_IDENTITY_PROVIDER_DESCRIPTOR
    : null;
}

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
  const [issuerUrl, setIssuerUrl] = useState(current === null ? "" : current.tokenUrl);
  const [clientId, setClientId] = useState(current === null ? "" : current.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const doCreate = useAtomSet(createOAuthClientOptimistic, { mode: "promiseExit" });
  const doProbe = useAtomSet(probeOAuth, { mode: "promiseExit" });

  const canSubmit = canSubmitEnterpriseIdentityProvider({ submitting, issuerUrl, clientId });

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    // Endpoints are DISCOVERED from the issuer, never typed. An administrator
    // knows their tenant's issuer; asking them to also transcribe an authorize
    // and a token path invites the one typo whose only symptom is every
    // member's connect failing later, at the identity provider, with a message
    // about the wrong host.
    const probed = await doProbe({ payload: { url: issuerUrl.trim() }, reactivityKeys: [] });
    if (Exit.isFailure(probed)) {
      setSubmitting(false);
      toast.error("Couldn't read that issuer's OpenID configuration. Check the URL, then retry.");
      return;
    }
    const exit = await doCreate({
      payload: enterpriseIdentityProviderPayload({
        authorizationUrl: probed.value.authorizationUrl,
        tokenUrl: probed.value.tokenUrl,
        clientId,
        clientSecret,
      }),
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
      toast.error("Couldn't save the identity provider. Check the issuer URL, then retry.");
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
            Register Executor as an application in your own identity provider, then paste its
            details here. Executor exchanges each member&apos;s work identity there for a grant
            naming one MCP server, so your identity provider — not the member — decides who reaches
            which server.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="ema-idp-issuer-url" className="text-xs text-muted-foreground">
              Issuer URL
              <span className="font-normal text-muted-foreground/70">
                endpoints are read from it
              </span>
            </Label>
            <Input
              id="ema-idp-issuer-url"
              autoComplete="off"
              placeholder="https://example.okta.com/oauth2/default"
              value={issuerUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIssuerUrl(e.target.value)}
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
            {submitting
              ? "Reading issuer…"
              : current === null
                ? "Register Provider"
                : "Save Provider"}
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
            Register Executor&apos;s application from your own identity provider. MCP servers marked
            as managed then connect with each member&apos;s work identity, instead of asking them to
            consent server by server.
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
              No identity provider yet. Register one before marking any MCP server as managed by
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
                  On a managed server, members connect with their work identity instead of a consent
                  screen — and access is revoked at your identity provider, not here.
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
