import { createRootRoute } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { ArtifactRendererProvider } from "@executor-js/react/api/artifact-renderer";
import { OrganizationProvider } from "@executor-js/react/api/organization-context";
import { OrgSlugGate } from "@executor-js/react/multiplayer/org-slug-gate";
import { Toaster } from "@executor-js/react/components/sonner";
import { AuthProvider, useAuth } from "@executor-js/react/multiplayer/auth-context";
import { Shell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

// ---------------------------------------------------------------------------
// Cloudflare root: the SAME shared multiplayer composition as cloud / self-host
// (AuthProvider → Shell → pages), with Cloudflare Access as the identity.
//
// Access authenticates the human at the edge BEFORE the request reaches the
// Worker, so there is no in-app login or first-run setup. `/account/me` (the
// CF AccountProvider) reflects the Access principal, so the auth gate only ever
// resolves to authenticated; the unauthenticated branch can only happen when
// Access isn't in front yet (or a JWT expired) — we bounce to the Access login.
//
// API keys + members are managed in Cloudflare Access, not in-app, so this host
// omits the API-keys nav item and just uses the default set.
// ---------------------------------------------------------------------------

// The MCP-Apps shell is browser-only — it imports `@tailwindcss/browser`, which
// touches `document` at import scope. It is registered as a dynamic import the
// artifact page resolves in the browser, never a static one, so it stays out of
// any server graph. Module scope keeps the loader identity stable, so the lazy
// component behind it never remounts.
const artifactRendererLoader = () => import("@executor-js/mcp-apps-shell/shell/artifact-renderer");

export const Route = createRootRoute({
  component: RootComponent,
});

// Sign-out is a redirect to Access's logout endpoint (it clears the Access
// session cookie); the next request re-prompts the Access login.
const signOut = () => {
  window.location.href = "/cdn-cgi/access/logout";
};

const Loading = ({ label }: { label: string }) => (
  <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
    {label}
  </div>
);

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  // Access already authenticated the user at the edge; an unauthenticated state
  // means there's no live Access session (gate not configured, or expired) —
  // send them through the Access login, which returns to the app with a JWT.
  useEffect(() => {
    if (auth.status === "unauthenticated") {
      window.location.href = "/cdn-cgi/access/login";
    }
  }, [auth.status]);

  if (auth.status === "authenticated") return <>{children}</>;
  return (
    <Loading label={auth.status === "unauthenticated" ? "Redirecting to sign in…" : "Loading…"} />
  );
}

function AuthenticatedApp() {
  const auth = useAuth();
  const organization = auth.status === "authenticated" ? (auth.organization ?? null) : null;

  // Single-org instance: a bare URL canonicalizes onto the instance org's
  // slug. There's only ever one org, so no other slug is reachable.
  const gated = (
    <>
      <Shell onSignOut={signOut} navItems={defaultShellNavItems} />
      <Toaster />
    </>
  );

  return (
    <ExecutorProvider>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        {/* No organizationSlug: the worker serves only the bare /mcp (see
            wrangler.jsonc run_worker_first), so a slug-pinned URL would fall
            through to the SPA. */}
        <OrganizationProvider organizationId={organization?.id ?? null}>
          <ArtifactRendererProvider loader={artifactRendererLoader}>
            {organization ? (
              <OrgSlugGate activeSlug={organization.slug}>{gated}</OrgSlugGate>
            ) : (
              gated
            )}
          </ArtifactRendererProvider>
        </OrganizationProvider>
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}

function RootComponent() {
  return (
    <AuthProvider>
      <AuthGate>
        <AuthenticatedApp />
      </AuthGate>
    </AuthProvider>
  );
}
