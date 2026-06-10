import { useMemo, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { OAuthClientSlug, type OAuthGrant, type Owner } from "@executor-js/sdk/shared";
import { toast } from "sonner";

import { createOAuthClientOptimistic, probeOAuth, registerDynamicOAuthClient } from "../api/atoms";
import { ownerLabelForHost } from "../api/owner-display";
import { useOrganizationId } from "../api/organization-context";
import { oauthClientWriteKeys } from "../api/reactivity-keys";
import { uniqueClientSlug } from "../plugins/use-effective-oauth-client";
import { oauthCallbackUrl } from "../plugins/oauth-sign-in";
import {
  ConnectionOwnerDropdown,
  connectionOwnerOptionsForHost,
  normalizeConnectionOwner,
} from "../plugins/connection-owner";
import { Button } from "./button";
import { CopyButton } from "./copy-button";
import { Input } from "./input";
import { Label } from "./label";
import { RadioGroup, RadioGroupItem } from "./radio-group";

// ---------------------------------------------------------------------------
// OAuth client registration form (reusable).
//
// Registers an owner-scoped OAuth app (`oauth.createClient`): the user pastes a
// client id/secret and confirms the endpoints/scopes, which pre-fill from the
// integration's declared OAuth method. The `slug` is a stable per-integration
// client slug passed by the caller — it is NOT user-entered.
//
// The form's owner (CLIENT owner: Personal vs Workspace) is DISTINCT from the
// connection's "saved to" owner — an org-owned app can back a user-owned
// connection so each employee mints their own token against the shared app.
// ---------------------------------------------------------------------------

export interface OAuthClientFormPrefill {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly resource?: string | null;
  readonly scopes?: readonly string[];
  readonly grant?: OAuthGrant;
  /** Client id to seed (e.g. when editing an existing app). NOT a secret — the
   *  secret is never returned, so it is always re-entered. */
  readonly clientId?: string;
  /** RFC 7591 registration endpoint. When known (from the integration's OAuth
   *  method or surfaced by Discover), the form offers a one-click "Register
   *  automatically" path that needs no pasted client id/secret. */
  readonly registrationEndpoint?: string;
}

export function OAuthClientForm(props: {
  /** Human label for the integration this app backs (used in toasts + default name). */
  readonly integrationName: string;
  /** Existing client slugs, so the generated slug stays unique across apps. */
  readonly existingSlugs: readonly string[];
  /** Endpoints/scopes declared by the integration's OAuth method. */
  readonly prefill?: OAuthClientFormPrefill;
  /** Reuse this exact slug instead of deriving one from the name. Set when
   *  editing an existing app — `createClient` upserts by `(owner, slug)`, so
   *  editing is re-registering with the same slug. */
  readonly fixedSlug?: OAuthClientSlug;
  /** Lock the client owner instead of letting the user choose. Set when editing
   *  (an app's owner is part of its identity and can't change). */
  readonly fixedOwner?: Owner;
  /** Called with the registered client owner + slug after a successful create. */
  readonly onCreated: (result: { readonly owner: Owner; readonly slug: OAuthClientSlug }) => void;
  readonly onCancel?: () => void;
  readonly surface?: "card" | "plain";
}) {
  const {
    integrationName,
    existingSlugs,
    prefill,
    fixedSlug,
    fixedOwner,
    onCreated,
    onCancel,
    surface = "card",
  } = props;
  // Non-org hosts (local/desktop) have one local workspace. Offer only Local,
  // so the owner dropdown (which hides on a single option) disappears.
  const organizationId = useOrganizationId();
  const ownerOptions = useMemo(
    () => connectionOwnerOptionsForHost(organizationId),
    [organizationId],
  );

  // The browser-facing callback the OAuth flow uses (this host's
  // `${origin}/api/oauth/callback`). It is the SAME value handed to `oauth.start`
  // and to DCR registration below, so showing it here is exactly the redirect a
  // user must allow-list on their OAuth app. Resolved from `window.location` so
  // it is automatically correct per platform (cloud / self-host / local).
  const callbackUrl = useMemo(() => oauthCallbackUrl(), []);

  // Explicit create-time choice (no ambient owner). Default Workspace (`org`) on
  // an org host, Local (`org`) on a non-org host, or the locked owner when
  // editing.
  const [owner, setOwner] = useState<Owner>(
    normalizeConnectionOwner(fixedOwner ?? "org", ownerOptions),
  );
  const [name, setName] = useState(integrationName);
  const [grant, setGrant] = useState<OAuthGrant>(prefill?.grant ?? "authorization_code");
  const [clientId, setClientId] = useState(prefill?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [issuerUrl, setIssuerUrl] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState(prefill?.authorizationUrl ?? "");
  const [tokenUrl, setTokenUrl] = useState(prefill?.tokenUrl ?? "");
  const [resource, setResource] = useState(prefill?.resource ?? null);
  const [discovering, setDiscovering] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // DCR (RFC 7591): the registration endpoint + advertised auth methods. Seeded
  // from the integration's OAuth method and refreshed by the Discover probe, so
  // a user can paste an MCP URL → Discover → Register automatically.
  const [registrationEndpoint, setRegistrationEndpoint] = useState(
    prefill?.registrationEndpoint ?? "",
  );
  const [authMethods, setAuthMethods] = useState<readonly string[] | undefined>(undefined);
  const [registering, setRegistering] = useState(false);

  // Endpoints/scopes usually come prefilled from the integration's declared
  // OAuth method, so collapse them behind an "Edit" — the common case is just
  // client id/secret + owner.
  const endpointsKnown = (prefill?.tokenUrl ?? "").length > 0;
  const [showEndpoints, setShowEndpoints] = useState(!endpointsKnown);

  const doCreate = useAtomSet(createOAuthClientOptimistic, { mode: "promiseExit" });
  const doProbe = useAtomSet(probeOAuth, { mode: "promiseExit" });
  const doRegisterDynamic = useAtomSet(registerDynamicOAuthClient, {
    mode: "promiseExit",
  });

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    clientId.trim().length > 0 &&
    clientSecret.trim().length > 0 &&
    tokenUrl.trim().length > 0 &&
    (grant === "client_credentials" || authorizationUrl.trim().length > 0);

  // DCR is offered when the server advertises a registration endpoint AND we
  // have the interactive-flow endpoints to persist alongside the minted client.
  const canRegisterDynamic =
    registrationEndpoint.trim().length > 0 &&
    authorizationUrl.trim().length > 0 &&
    tokenUrl.trim().length > 0 &&
    grant === "authorization_code";

  const handleDiscover = async () => {
    const url = issuerUrl.trim();
    if (url.length === 0) {
      toast.error("Enter an issuer URL to discover endpoints");
      return;
    }
    setDiscovering(true);
    // Probe is a pure discovery read — no shared state to invalidate. The empty
    // `reactivityKeys` documents that for the `require-reactivity-keys` rule.
    const exit = await doProbe({ payload: { url }, reactivityKeys: [] });
    setDiscovering(false);
    if (Exit.isFailure(exit)) {
      toast.error("Could not discover OAuth endpoints");
      return;
    }
    const result = exit.value;
    setAuthorizationUrl(result.authorizationUrl);
    setTokenUrl(result.tokenUrl);
    setResource(result.resource ?? null);
    // Capture DCR availability so the "Register automatically" path shows for a
    // pasted MCP/issuer URL without any client id/secret.
    setRegistrationEndpoint(result.registrationEndpoint ?? "");
    setAuthMethods(result.tokenEndpointAuthMethodsSupported);
    toast.success(
      result.registrationEndpoint
        ? "Discovered OAuth endpoints — automatic registration available"
        : "Discovered OAuth endpoints",
    );
  };

  const handleRegisterDynamic = async () => {
    if (!canRegisterDynamic || registering) return;
    setRegistering(true);
    const slug = fixedSlug ?? uniqueClientSlug(name, existingSlugs);
    const exit = await doRegisterDynamic({
      payload: {
        owner,
        slug,
        registrationEndpoint: registrationEndpoint.trim(),
        authorizationUrl: authorizationUrl.trim(),
        tokenUrl: tokenUrl.trim(),
        resource,
        // DCR sends the integration's declared scopes to the AS at registration
        // (the app itself stores none).
        scopes: [...(prefill?.scopes ?? [])],
        tokenEndpointAuthMethodsSupported: authMethods,
        clientName: name.trim(),
        redirectUri: oauthCallbackUrl(),
      },
      reactivityKeys: oauthClientWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setRegistering(false);
      toast.error("Automatic registration failed — enter a client ID and secret instead");
      return;
    }
    toast.success(`Registered ${integrationName} OAuth app`);
    onCreated({ owner, slug });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const slug = fixedSlug ?? uniqueClientSlug(name, existingSlugs);
    const exit = await doCreate({
      payload: {
        owner,
        slug,
        authorizationUrl: authorizationUrl.trim(),
        tokenUrl: tokenUrl.trim(),
        grant,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        resource,
      },
      reactivityKeys: oauthClientWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setSubmitting(false);
      toast.error("Failed to register OAuth app");
      return;
    }
    toast.success(`Registered ${integrationName} OAuth app`);
    onCreated({ owner, slug });
  };

  return (
    <div
      className={
        surface === "card"
          ? "space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4"
          : "space-y-4"
      }
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">Register an OAuth app</p>
        <p className="text-xs text-muted-foreground">
          {canRegisterDynamic
            ? "Register automatically below, or enter a client id/secret manually."
            : "Paste a client id/secret. We only ask for endpoints when they aren't already known."}
        </p>
      </div>

      {/* app name */}
      <div className="space-y-1.5">
        <Label htmlFor="oauth-app-name" className="text-xs text-muted-foreground">
          App name
          <span className="font-normal text-muted-foreground/70">to tell your apps apart</span>
        </Label>
        <Input
          id="oauth-app-name"
          placeholder={integrationName}
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
      </div>

      {/* register automatically (RFC 7591 DCR) — the primary path when the
          server advertises a registration endpoint: no client id/secret needed */}
      {canRegisterDynamic ? (
        <div className="space-y-2 rounded-lg border border-ring/40 bg-accent/30 p-3">
          <p className="text-sm font-medium">No client ID needed</p>
          <p className="text-xs text-muted-foreground">
            This server supports automatic registration. We register a public app for you and use
            PKCE — you don&apos;t paste any client id or secret.
          </p>
          <Button
            type="button"
            onClick={() => void handleRegisterDynamic()}
            disabled={registering || name.trim().length === 0}
            className="w-full"
          >
            {registering ? "Registering…" : "Register automatically — no client ID needed"}
          </Button>
        </div>
      ) : null}

      {/* grant */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Grant type</Label>
        <RadioGroup
          value={grant}
          onValueChange={(next: string) => setGrant(next as OAuthGrant)}
          className="gap-2"
        >
          {(
            [
              {
                value: "authorization_code",
                label: "Authorization code",
                hint: "User signs in",
              },
              {
                value: "client_credentials",
                label: "Client credentials",
                hint: "App-to-app, no user",
              },
            ] as const
          ).map((option) => (
            <Label
              key={option.value}
              htmlFor={`grant-${option.value}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2 font-normal has-[:checked]:border-ring has-[:checked]:bg-accent/40"
            >
              <RadioGroupItem
                id={`grant-${option.value}`}
                value={option.value}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </div>

      {/* divider before the manual (secondary) path when DCR is available */}
      {canRegisterDynamic ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border/60" />
          or enter a client ID manually
          <span className="h-px flex-1 bg-border/60" />
        </div>
      ) : null}

      {/* callback URL — the redirect the authorization-code flow uses. Show it
          so the user can allow-list it on their OAuth app. Client-credentials
          has no browser redirect, so it is hidden for that grant. */}
      {grant === "authorization_code" ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Callback URL
            <span className="font-normal text-muted-foreground/70">
              add this to your OAuth app&apos;s allowed redirects
            </span>
          </Label>
          <div className="flex items-center gap-1 rounded-md border border-border bg-background/50 px-2.5 py-1.5">
            <span
              id="oauth-callback-url"
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
            >
              {callbackUrl}
            </span>
            <CopyButton value={callbackUrl} />
          </div>
        </div>
      ) : null}

      {/* client id / secret */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="oauth-client-id" className="text-xs text-muted-foreground">
            Client ID
          </Label>
          <Input
            id="oauth-client-id"
            placeholder="client id"
            value={clientId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="oauth-client-secret" className="text-xs text-muted-foreground">
            Client secret
          </Label>
          <Input
            id="oauth-client-secret"
            type="password"
            autoComplete="new-password"
            placeholder="client secret"
            value={clientSecret}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSecret(e.target.value)}
            className="font-mono"
            data-ph-block
          />
        </div>
      </div>

      {/* endpoints + scopes — collapsed when the integration already declares them */}
      {endpointsKnown && !showEndpoints ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowEndpoints(true)}
          className="h-auto w-full justify-start gap-2 px-3 py-2 text-xs font-normal text-muted-foreground"
        >
          <span className="text-emerald-500">✓</span>
          Endpoints set from {integrationName}
          <span className="ml-auto font-medium text-foreground">Edit</span>
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg border border-border/50 bg-background/30 p-3">
          {/* discovery */}
          <div className="space-y-1.5">
            <Label htmlFor="oauth-issuer-url" className="text-xs text-muted-foreground">
              Discover endpoints
              <span className="font-normal text-muted-foreground/70">optional</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="oauth-issuer-url"
                placeholder="https://issuer.example.com"
                value={issuerUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIssuerUrl(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleDiscover()}
                disabled={discovering}
              >
                {discovering ? "Discovering…" : "Discover"}
              </Button>
            </div>
          </div>

          {grant === "authorization_code" ? (
            <div className="space-y-1.5">
              <Label htmlFor="oauth-authorization-url" className="text-xs text-muted-foreground">
                Authorization URL
              </Label>
              <Input
                id="oauth-authorization-url"
                placeholder="https://issuer.example.com/authorize"
                value={authorizationUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setAuthorizationUrl(e.target.value)
                }
                className="font-mono"
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="oauth-token-url" className="text-xs text-muted-foreground">
              Token URL
            </Label>
            <Input
              id="oauth-token-url"
              placeholder="https://issuer.example.com/token"
              value={tokenUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTokenUrl(e.target.value)}
              className="font-mono"
            />
          </div>

          {endpointsKnown ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowEndpoints(false)}
              className="h-auto px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              Done editing
            </Button>
          ) : null}
        </div>
      )}

      {/* client owner (distinct from the connection's saved-to owner). Locked
          when editing — an app's owner is part of its (owner, slug) identity. */}
      {fixedOwner ? (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Owner</Label>
          <p className="text-sm">
            {ownerLabelForHost(fixedOwner, organizationId)}
            <span className="ml-2 text-xs text-muted-foreground">
              can&apos;t change after creation
            </span>
          </p>
        </div>
      ) : (
        <ConnectionOwnerDropdown
          value={owner}
          options={ownerOptions}
          onChange={(next: Owner) => setOwner(next)}
          label="Register app for"
          help={`Personal apps are yours only; Workspace apps are shared with everyone (each ${ownerLabelForHost(
            "user",
            organizationId,
          ).toLowerCase()} still mints their own connection).`}
        />
      )}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? "Registering…" : "Register app"}
        </Button>
      </div>
    </div>
  );
}
