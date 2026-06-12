import React from "react";
import * as Sentry from "@sentry/react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { AutumnProvider } from "autumn-js/react";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import type { FrontendErrorReporter } from "@executor-js/react/api/error-reporting";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { OrganizationProvider } from "@executor-js/react/api/organization-context";
import { Toaster } from "@executor-js/react/components/sonner";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
import type { AuthHint } from "@executor-js/react/multiplayer/auth-hint";
import { AuthProvider, useAuth } from "../web/auth";
import { loginPath } from "../auth/return-to";
import { ONBOARDING_PATHS, PUBLIC_PATHS } from "../auth/route-paths";
import { SupportOptions } from "../web/components/support-options";
import { Shell } from "../web/shell";
import appCss from "@executor-js/react/globals.css?url";

if (typeof window !== "undefined" && import.meta.env.VITE_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_PUBLIC_SENTRY_DSN,
    tunnel: "/api/sentry-tunnel",
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}

if (typeof window !== "undefined" && import.meta.env.VITE_PUBLIC_POSTHOG_KEY) {
  const analyticsPath = (import.meta.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a").replace(
    /^\/+|\/+$/g,
    "",
  );

  posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_KEY, {
    api_host:
      import.meta.env.VITE_PUBLIC_POSTHOG_HOST ?? `${window.location.origin}/api/${analyticsPath}`,
    ui_host: "https://us.posthog.com",
    defaults: "2025-05-24",
    person_profiles: "identified_only",
    disable_session_recording: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
      blockSelector: "[data-ph-block]",
    },
  });
}

const captureFrontendError: FrontendErrorReporter = (error, context) => {
  Sentry.captureException(error, (scope) => {
    scope.setTag("executor.ui.surface", context.surface);
    scope.setTag("executor.ui.action", context.action);
    scope.setTag("executor.ui.severity", context.severity ?? "error");
    scope.setContext("executor.ui", {
      surface: context.surface,
      action: context.action,
      message: context.message,
      metadata: context.metadata,
    });
    return scope;
  });
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
          className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
        >
          Go home
        </a>
      </section>
    </main>
  );
}

export const Route = createRootRoute({
  notFoundComponent: NotFoundPage,
  // The verified identity the SSR gate attached to this document request
  // (ssr-gate.ts → middleware context → serverContext). Loader data is
  // dehydrated, so the client's first render sees the SAME hint the server
  // rendered with — the two can't disagree. Client-side re-runs have no
  // serverContext and return null, which is fine: the hint only seeds
  // initial state (AuthProvider holds it from there).
  loader: (opts) => ({
    authHint:
      (opts as { serverContext?: { authHint?: AuthHint | null } }).serverContext?.authHint ?? null,
  }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Executor Cloud" },
    ],
    links: [
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" },
      { rel: "icon", type: "image/png", sizes: "192x192", href: "/favicon-192.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { authHint } = Route.useLoaderData();
  return (
    <PostHogProvider client={posthog}>
      <AuthProvider initialHint={authHint}>
        <AuthGate />
      </AuthProvider>
    </PostHogProvider>
  );
}

// Neutral, layout-free placeholder for the moments no UI is correct yet: a
// redirect in flight, or the (post-gate, near-impossible) hint-less verified
// load. Never the app shell's silhouette — that bet is the bug this file's
// gate exists to prevent.
function BlankScreen() {
  return <div className="h-screen bg-background" />;
}

function ShellErrorFallback() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-full border border-border bg-muted">
          <span className="text-lg font-semibold text-muted-foreground">!</span>
        </div>
        <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          We&apos;ve tracked it. Give refreshing a try, and get in touch if support is needed.
        </p>
        <p className="mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Get support
        </p>
        <div className="mt-3">
          <SupportOptions />
        </div>
      </section>
    </main>
  );
}

function AuthGate() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isOnboardingRoute = ONBOARDING_PATHS.has(location.pathname);
  const isPublicRoute = PUBLIC_PATHS.has(location.pathname);

  // The SSR gate already bounced fresh org-less document requests to
  // /create-org; this catches the MID-SESSION transitions (org deleted,
  // membership revoked → /account/me now reports no org).
  const needsOrgRedirect =
    auth.status === "authenticated" &&
    auth.organization == null &&
    !isOnboardingRoute &&
    !isPublicRoute;

  React.useEffect(() => {
    if (needsOrgRedirect) {
      void navigate({ to: "/create-org", replace: true });
    }
  }, [needsOrgRedirect, navigate]);

  // The signed-out safety net behind the SSR gate: if a session dies while
  // the SPA is already loaded (logout elsewhere, expiry), go to /login the
  // same way a fresh document request would — keeping where they were.
  const needsLoginRedirect = auth.status === "unauthenticated" && !isPublicRoute;
  React.useEffect(() => {
    if (needsLoginRedirect) {
      window.location.assign(loginPath(`${location.pathname}${location.searchStr}`));
    }
  }, [needsLoginRedirect, location.pathname, location.searchStr]);

  if (isPublicRoute) {
    return <Outlet />;
  }

  // Every state that isn't "authenticated with an org, on a page that wants
  // the shell" is a moment between redirects or an edge the gates make
  // near-impossible (a verified user whose hint hasn't seeded yet). Neutral
  // blank — the one placeholder that's correct whatever happens next. The
  // app-shell skeleton this file used to render here is exactly the
  // wrong-UI flash the SSR gate + hint exist to prevent.
  if (auth.status === "loading" || auth.status === "unauthenticated") {
    return <BlankScreen />;
  }

  if (isOnboardingRoute) {
    return <Outlet />;
  }

  if (auth.organization == null) {
    return <BlankScreen />;
  }

  return (
    <AutumnProvider pathPrefix="/api/billing">
      <Sentry.ErrorBoundary fallback={<ShellErrorFallback />} showDialog={false}>
        <ExecutorProvider onHandledError={captureFrontendError}>
          <React.Suspense fallback={<BlankScreen />}>
            <ExecutorPluginsProvider plugins={clientPlugins}>
              <OrganizationProvider organizationId={auth.organization.id}>
                <Shell />
                <Toaster />
              </OrganizationProvider>
            </ExecutorPluginsProvider>
          </React.Suspense>
        </ExecutorProvider>
      </Sentry.ErrorBoundary>
    </AutumnProvider>
  );
}
