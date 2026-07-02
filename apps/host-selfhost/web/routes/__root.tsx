import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { OrganizationProvider } from "@executor-js/react/api/organization-context";
import { OrgSlugGate } from "@executor-js/react/multiplayer/org-slug-gate";
import { Toaster } from "@executor-js/react/components/sonner";
import { Button } from "@executor-js/react/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@executor-js/react/components/card";
import { AuthProvider, useAuth } from "@executor-js/react/multiplayer/auth-context";
import { Shell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

import { authClient } from "../auth-client";
import { DevicePage } from "../chromeless/device-page";
import { McpConsentPage } from "../chromeless/mcp-consent-page";
import { LoginPage } from "../login";
import { SetupPage } from "../setup";
import { fetchNeedsSetup } from "../setup-status";

// ---------------------------------------------------------------------------
// Self-host root: the SHARED multiplayer composition with Better Auth as the
// provider. Same shell, pages, and account surface as cloud — the only
// self-host specifics are the login form (email/password) and sign-out (Better
// Auth), injected here. No billing, Sentry, or PostHog.
// ---------------------------------------------------------------------------

export const Route = createRootRoute({
  notFoundComponent: NotFoundPage,
  component: RootComponent,
});

// Self-host adds the account's API keys and the instance Admin page (members +
// invite links) to the shared nav. The Admin page and its API gate to
// owner/admin, so a non-admin who opens it just sees the access notice.
const selfHostNavItems = [
  ...defaultShellNavItems,
  { to: "/api-keys", label: "API keys" },
  { to: "/admin", label: "Admin" },
];

const signOut = async () => {
  await authClient.signOut();
  window.location.href = "/";
};

function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">404</p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          There&apos;s nothing at this address.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          Go home
        </a>
      </section>
    </main>
  );
}

const Loading = () => (
  <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
    Loading…
  </div>
);

const SetupStatusErrorCard = ({ onRetry }: { onRetry: () => void }) => (
  <div className="flex min-h-screen items-center justify-center bg-background p-6">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Can't reach the server</CardTitle>
        <CardDescription>
          Executor couldn't check this instance's setup state. Make sure the server is running, then
          retry.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  </div>
);

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  // When unauthenticated, decide between first-run setup and sign-in by asking
  // the server whether the instance still has zero members.
  const [setupStatus, setSetupStatus] = useState<
    | { state: "checking"; attempt: number }
    | { state: "ready"; needsSetup: boolean }
    | { state: "error"; attempt: number }
  >({ state: "checking", attempt: 0 });
  useEffect(() => {
    if (auth.status !== "unauthenticated") return;
    let alive = true;
    setSetupStatus((current) => ({ state: "checking", attempt: current.attempt }));
    void fetchNeedsSetup().then(
      (value) => {
        if (alive) setSetupStatus({ state: "ready", needsSetup: value });
      },
      () => {
        if (alive) {
          setSetupStatus((current) => ({
            state: "error",
            attempt: current.state === "ready" ? 0 : current.attempt,
          }));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [auth.status, setupStatus.attempt]);

  if (auth.status === "loading") return <Loading />;
  if (auth.status === "unauthenticated") {
    if (setupStatus.state === "checking") return <Loading />;
    if (setupStatus.state === "error") {
      return (
        <SetupStatusErrorCard
          onRetry={() =>
            setSetupStatus((current) => ({
              state: "checking",
              attempt: current.state === "ready" ? 0 : current.attempt + 1,
            }))
          }
        />
      );
    }
    return setupStatus.needsSetup ? <SetupPage /> : <LoginPage />;
  }
  return <>{children}</>;
}

function AuthenticatedApp() {
  const auth = useAuth();
  const organization = auth.status === "authenticated" ? (auth.organization ?? null) : null;

  // Single-org instance: a bare URL canonicalizes onto the instance org's
  // slug. There's only ever one org, so no other slug is reachable.
  const gated = (
    <>
      <Shell onSignOut={signOut} navItems={selfHostNavItems} />
      <Toaster />
    </>
  );

  return (
    <ExecutorProvider>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        {/* No organizationSlug: the self-host MCP endpoint is the bare /mcp —
            a slug-pinned URL would 404, and a single-org instance has nothing
            to select anyway. */}
        <OrganizationProvider organizationId={organization?.id ?? null}>
          {organization ? <OrgSlugGate activeSlug={organization.slug}>{gated}</OrgSlugGate> : gated}
        </OrganizationProvider>
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // The join page is public + chromeless: a new user redeeming an invite link
  // has no session yet, so it renders outside the auth gate and the shell.
  if (pathname.startsWith("/join/")) {
    return (
      <>
        <Outlet />
        <Toaster />
      </>
    );
  }

  // The MCP OAuth approval screen: chromeless (no shell) but inside the auth
  // gate — the user is already signed in (Better Auth's authorize requires a
  // session before redirecting here). Rendered directly (static import), not as
  // a lazy route, so it can't hit Vite's dynamic-import dep flake.
  if (pathname === "/mcp-consent") {
    return (
      <AuthProvider>
        <AuthGate>
          <McpConsentPage />
          <Toaster />
        </AuthGate>
      </AuthProvider>
    );
  }

  // The CLI device-login verification page: chromeless, inside the auth gate
  // (the user signs in here if needed, then authorizes the code). Same
  // static-import + pathname-branch convention as /mcp-consent.
  if (pathname === "/device") {
    return (
      <AuthProvider>
        <AuthGate>
          <DevicePage />
          <Toaster />
        </AuthGate>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <AuthGate>
        <AuthenticatedApp />
      </AuthGate>
    </AuthProvider>
  );
}
