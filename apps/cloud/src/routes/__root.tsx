import React from "react";
import * as Sentry from "@sentry/react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { AutumnProvider } from "autumn-js/react";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import type { FrontendErrorReporter } from "@executor-js/react/api/error-reporting";
import { AnalyticsProvider, type AnalyticsClient } from "@executor-js/react/api/analytics";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { OrganizationProvider } from "@executor-js/react/api/organization-context";
import { EXECUTOR_ORG_HEADER } from "@executor-js/react/api/server-connection";
import { OrgSlugGate } from "@executor-js/react/multiplayer/org-slug-gate";
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

const analyticsClient: AnalyticsClient | undefined =
  typeof window !== "undefined" && import.meta.env.VITE_PUBLIC_POSTHOG_KEY
    ? (name, properties) => posthog.capture(name, properties)
    : undefined;

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
  // What the SSR gate attached to this document request (ssr-gate.ts →
  // middleware context → serverContext). Loader data is dehydrated, so the
  // client's first render sees the SAME values the server rendered with — the
  // two can't disagree:
  //   - authHint: the verified identity, seeding AuthProvider's initial state.
  //   - origin:   the request origin, seeding the server connection so the
  //               connect-card MCP URL SSRs as the real origin instead of the
  //               127.0.0.1 client-side default (which would flash to the real
  //               value at hydration).
  // Client-side re-runs have no serverContext and return null; both consumers
  // fall back gracefully (the hint is already held, the origin to the
  // window-derived global).
  loader: (opts) => {
    const serverContext = (
      opts as { serverContext?: { authHint?: AuthHint | null; origin?: string } }
    ).serverContext;
    return {
      authHint: serverContext?.authHint ?? null,
      origin: serverContext?.origin ?? null,
    };
  },
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
        href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;700&display=swap",
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
  const { authHint, origin } = Route.useLoaderData();
  return (
    <PostHogProvider client={posthog}>
      <AnalyticsProvider client={analyticsClient}>
        <AuthProvider initialHint={authHint}>
          <AuthGate ssrOrigin={origin} />
        </AuthProvider>
      </AnalyticsProvider>
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

function AuthGate({ ssrOrigin }: { ssrOrigin: string | null }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isOnboardingRoute = ONBOARDING_PATHS.has(location.pathname);
  const isPublicRoute = PUBLIC_PATHS.has(location.pathname);
  // The org the URL names (the `{-$orgSlug}` segment), if any. `/account/me`
  // is scoped to it, so `auth.organization` IS this org when the caller is a
  // member — and `null` when the URL names an org they can't access.
  const urlOrgSlug = (useParams({ strict: false }) as { orgSlug?: string }).orgSlug;

  // The SSR gate already bounced fresh org-less document requests to
  // /create-org; this catches the MID-SESSION transitions (org deleted,
  // membership revoked → /account/me now reports no org). Only for BARE paths:
  // an org-less result on a slugged URL is a wrong address (404 below), not a
  // reason to send the user to onboarding.
  const needsOrgRedirect =
    auth.status === "authenticated" &&
    auth.organization == null &&
    !urlOrgSlug &&
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
    // A URL naming an org this session can't access (`/account/me` returned no
    // org for its slug) is a wrong address → the route 404, framed by nothing
    // (the user isn't "in" any org here). A bare path with no org is a new
    // user — the redirect effect above is taking them to onboarding.
    return urlOrgSlug ? <NotFoundPage /> : <BlankScreen />;
  }

  // Seed the server connection from the SSR origin so origin-derived UI (the
  // connect card's MCP URL) renders the real host on the first paint instead
  // of the 127.0.0.1 default the client-side global falls back to during SSR.
  // Null on client loader re-runs → undefined → the window-derived global,
  // which is the same origin, so the key never changes and nothing remounts.
  const connection = ssrOrigin ? ({ kind: "http", origin: ssrOrigin } as const) : undefined;
  const activeSlug = auth.organization.slug;
  // The org context's slug feeds the connect card's `/<slug>/mcp` install URL.
  // Prefer the URL's slug over the session's: on first paint `auth.organization`
  // comes from the SSR auth-hint (the COOKIE's org), so a multi-org user viewing
  // /<orgB> while their cookie still points at orgA would briefly render orgA's
  // slug in the copyable URL before /account/me (URL-scoped) corrects it. The
  // URL slug is the actual request scope and is correct on the very first paint,
  // so sourcing it from there removes that flash. Falls back to the session slug
  // on a bare URL (which OrgSlugGate is about to canonicalize onto it anyway).
  const scopeSlug = urlOrgSlug ?? activeSlug;
  const billingHeaders = scopeSlug ? { [EXECUTOR_ORG_HEADER]: scopeSlug } : undefined;

  return (
    <AutumnProvider pathPrefix="/api/billing" headers={billingHeaders}>
      <Sentry.ErrorBoundary fallback={<ShellErrorFallback />} showDialog={false}>
        <ExecutorProvider connection={connection} onHandledError={captureFrontendError}>
          <React.Suspense fallback={<BlankScreen />}>
            <ExecutorPluginsProvider plugins={clientPlugins}>
              <OrganizationProvider
                organizationId={auth.organization.id}
                organizationSlug={scopeSlug}
              >
                {/* The org header scopes every request to the URL's org, so
                    reaching here means the caller is a member of `activeSlug`
                    (a foreign slug already 404'd above). The gate only keeps
                    the URL canonical — bare → /<slug>. */}
                <OrgSlugGate activeSlug={activeSlug}>
                  <Shell />
                  <Toaster />
                </OrgSlugGate>
              </OrganizationProvider>
            </ExecutorPluginsProvider>
          </React.Suspense>
        </ExecutorProvider>
      </Sentry.ErrorBoundary>
    </AutumnProvider>
  );
}
