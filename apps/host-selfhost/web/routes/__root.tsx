import { createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { Toaster } from "@executor-js/react/components/sonner";
import { AuthProvider, useAuth } from "@executor-js/react/multiplayer/auth-context";
import { Shell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

import { authClient } from "../auth-client";
import { LoginPage } from "../login";

// ---------------------------------------------------------------------------
// Self-host root: the SHARED multiplayer composition with Better Auth as the
// provider. Same shell, pages, and account surface as cloud — the only
// self-host specifics are the login form (email/password) and sign-out (Better
// Auth), injected here. No billing, Sentry, or PostHog.
// ---------------------------------------------------------------------------

export const Route = createRootRoute({
  component: RootComponent,
});

const signOut = async () => {
  await authClient.signOut();
  window.location.href = "/";
};

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (auth.status === "unauthenticated") {
    return <LoginPage />;
  }
  return <>{children}</>;
}

function RootComponent() {
  return (
    <AuthProvider>
      <AuthGate>
        <ExecutorProvider>
          <ExecutorPluginsProvider plugins={clientPlugins}>
            <Shell onSignOut={signOut} navItems={defaultShellNavItems} />
            <Toaster />
          </ExecutorPluginsProvider>
        </ExecutorProvider>
      </AuthGate>
    </AuthProvider>
  );
}
