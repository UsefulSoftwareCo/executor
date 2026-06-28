import { useState } from "react";

import { Button } from "@executor-js/react/components/button";

// ---------------------------------------------------------------------------
// MCP OAuth consent. Better Auth's mcp() plugin redirects /authorize here
// (consentPage) with ?consent_code&client_id&scope once the user is signed in;
// the self-host serving layer forces it for every client (see
// src/auth/force-mcp-consent) and enriches it with the registered client_name
// (src/auth/index). We show the requesting client + scopes and require an
// explicit Allow/Deny — without this the server would auto-consent, so any
// authorize link clicked by a logged-in user would silently mint a token for
// whoever crafted it. On a decision we POST /api/auth/oauth2/consent and follow
// the returned redirectURI (back to the client's callback with a code, or with
// an access_denied error). Rendered directly by routes/__root.tsx (a static
// import, not a lazy route — so it can't hit Vite's dynamic-import dep flake),
// chromeless inside the auth gate. No throws (result drives state).
// ---------------------------------------------------------------------------

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "Read your basic profile",
  email: "Read your email address",
  offline_access: "Stay connected (refresh access without re-approving)",
};

export const McpConsentPage = () => {
  const params = new URLSearchParams(globalThis.window?.location.search ?? "");
  const consentCode = params.get("consent_code") ?? "";
  const clientId = params.get("client_id") ?? "";
  // The name the client gave at registration (e.g. "Codex"). Self-declared, so
  // it's shown as a label, not a trust signal — hence the id + warning below.
  const clientName = params.get("client_name")?.trim() || "";
  const scopes = (params.get("scope") ?? "").split(/[+\s]+/).filter(Boolean);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (accept: boolean) => {
    setBusy(accept ? "allow" : "deny");
    setError(null);
    const res = await fetch(`${globalThis.location.origin}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ accept, consent_code: consentCode }),
    });
    if (!res.ok) {
      setBusy(null);
      setError(
        "Could not record your decision. The request may have expired — try connecting again.",
      );
      return;
    }
    const body = (await res.json()) as { redirectURI?: string };
    if (body.redirectURI) {
      globalThis.location.href = body.redirectURI;
      return;
    }
    setBusy(null);
    setError("No redirect was returned by the server.");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div
        id="mcp-consent"
        className="w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1 text-center">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            {clientName ? `Connect ${clientName}?` : "Connect an agent?"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {clientName ? `${clientName} is` : "An MCP client is"} asking to connect to your
            Executor instance.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Requesting client
          </div>
          {clientName && <div className="text-sm font-medium text-foreground">{clientName}</div>}
          <code className="block break-all text-xs text-muted-foreground">
            {clientId || "(unknown)"}
          </code>
          <div className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            It will be able to
          </div>
          <ul className="space-y-1 text-sm text-foreground">
            {(scopes.length ? scopes : ["openid"]).map((s) => (
              <li key={s} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{SCOPE_LABELS[s] ?? s}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Scope of the grant: this token is an MCP credential only. */}
        <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          This access is limited to the{" "}
          <span className="font-medium text-foreground">MCP server</span>: the client connects as an
          MCP client and uses your tools through this instance&apos;s{" "}
          <code className="mx-0.5">/mcp</code> endpoint. It is not a web-app login and can&apos;t
          make other API calls on your behalf.
        </div>

        <p className="text-xs text-muted-foreground">
          Only allow this if you just started connecting an agent yourself.
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-3">
          <Button
            id="mcp-consent-deny"
            type="button"
            variant="outline"
            className="flex-1"
            disabled={busy !== null}
            onClick={() => void decide(false)}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
          <Button
            id="mcp-consent-allow"
            type="button"
            className="flex-1"
            disabled={busy !== null || !consentCode}
            onClick={() => void decide(true)}
          >
            {busy === "allow" ? "Allowing…" : "Allow"}
          </Button>
        </div>
      </div>
    </div>
  );
};
