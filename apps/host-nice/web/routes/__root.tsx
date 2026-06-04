import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { Toaster } from "@executor-js/react/components/sonner";
import { AuthProvider, useAuth } from "@executor-js/react/multiplayer/auth-context";
import { Shell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

import { authClient } from "../auth-client";
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
  component: RootComponent,
});

// Self-host adds the instance Admin page (members + invite links) to the shared
// nav. The page and its API gate to owner/admin, so a non-admin who opens it
// just sees the access notice.
const selfHostNavItems = [...defaultShellNavItems, { to: "/admin", label: "Admin" }];

const signOut = async () => {
  await authClient.signOut();
  window.location.href = "/";
};

const Loading = () => (
  <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
    Loading…
  </div>
);

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  // When unauthenticated, decide between first-run setup and sign-in by asking
  // the server whether the instance still has zero members. `null` = checking.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    if (auth.status !== "unauthenticated") return;
    let alive = true;
    void fetchNeedsSetup().then((value) => {
      if (alive) setNeedsSetup(value);
    });
    return () => {
      alive = false;
    };
  }, [auth.status]);

  if (auth.status === "loading") return <Loading />;
  if (auth.status === "unauthenticated") {
    if (needsSetup === null) return <Loading />;
    return needsSetup ? <SetupPage /> : <LoginPage />;
  }
  return <>{children}</>;
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

  return (
    <AuthProvider>
      <AuthGate>
        <ExecutorProvider>
          <ExecutorPluginsProvider plugins={clientPlugins}>
            <Shell onSignOut={signOut} navItems={selfHostNavItems} />
            <Toaster />
          </ExecutorPluginsProvider>
        </ExecutorProvider>
      </AuthGate>
    </AuthProvider>
  );
}
