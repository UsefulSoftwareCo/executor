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
import { isValidOrgSlug } from "@executor-js/api";
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
import { ArtifactRendererProvider } from "@executor-js/react/api/artifact-renderer";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
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

// The MCP-Apps shell is browser-only — it imports `@tailwindcss/browser`, which
// touches `document` at import scope. A static import here would put it in this
// SSR app's server graph and 500 every document request, so it is registered as
// a dynamic import the artifact page resolves in the browser. Module scope keeps
// the loader identity stable, so the lazy component behind it never remounts.
const artifactRendererLoader = () => import("@executor-js/mcp-apps-shell/shell/artifact-renderer");

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
  // SPA mode: no per-request server render, so nothing is dehydrated. Auth
  // seeds from the client-readable hint cookie one frame after mount
  // (AuthProvider's own fallback), and origin-derived UI reads the
  // window-derived global.
  return (
    <PostHogProvider client={posthog}>
      <AnalyticsProvider client={analyticsClient}>
        <AuthProvider>
          <AuthGate />
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

function AuthGate() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isOnboardingRoute = ONBOARDING_PATHS.has(location.pathname);
  const isPublicRoute = PUBLIC_PATHS.has(location.pathname);
  // The org the URL names (the `{-$orgSlug}` segment), if any. `/account/me`
  // is scoped to it, so `auth.organization` IS this org when the caller is a
  // member — and `null` when the URL names an org they can't access.
  const urlOrgSlug = (useParams({ strict: false }) as { orgSlug?: string }).orgSlug;
  // The same slug derived from the PATHNAME instead of the route params: the
  // params resolve asynchronously (a fresh load renders once with no orgSlug,
  // then again with it), and anything keyed on them remounts on that flap.
  // The pathname is synchronously correct on the very first render, and it is
  // exactly what the request header derives from (getActiveOrgSlug), so the
  // registry scope below can never disagree with the header scope.
  const firstSegment = location.pathname.split("/")[1] ?? "";
  const pathnameOrgSlug = isValidOrgSlug(firstSegment) ? firstSegment : null;

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
  // the shell" is a moment between redirects, or the one frame between mount
  // and the hint cookie seeding (SPA mode reads it in an effect). Neutral
  // blank — the one placeholder that's correct whatever happens next. The
  // app-shell skeleton this file used to render here is exactly the
  // wrong-UI flash the document gate + hint exist to prevent.
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

  const activeSlug = auth.organization.slug;
  // The org context's slug feeds the connect card's `/<slug>/mcp` install URL.
  // Prefer the URL's slug over the session's: on first paint `auth.organization`
  // comes from the SSR auth-hint (the COOKIE's org), so a multi-org user viewing
  // /<orgB> while their cookie still points at orgA would briefly render orgA's
  // slug in the copyable URL before /account/me (URL-scoped) corrects it. The
  // URL slug is the actual request scope and is correct on the very first paint,
  // so sourcing it from there removes that flash. VALIDATED (pathnameOrgSlug,
  // not the raw route param): the `{-$orgSlug}` param also captures reserved
  // console roots ("/integrations" → orgSlug "integrations"), which are not
  // org scopes. Falls back to the auth org on a bare/reserved URL (which
  // OrgSlugGate canonicalizes onto it below).
  const scopeSlug = pathnameOrgSlug ?? activeSlug;
  const billingHeaders = scopeSlug ? { [EXECUTOR_ORG_HEADER]: scopeSlug } : undefined;

  return (
    <AutumnProvider pathPrefix="/api/billing" headers={billingHeaders}>
      <Sentry.ErrorBoundary fallback={<ShellErrorFallback />} showDialog={false}>
        {/* scopeKey ties the atom registry to the URL's org: cached query
            results can never survive an org change, and the bare → slugged
            canonicalization remounts the registry so anything fetched
            header-less on first paint (rejected server-side) is refetched
            with the org header. */}
        <ExecutorProvider scopeKey={pathnameOrgSlug} onHandledError={captureFrontendError}>
          <React.Suspense fallback={<BlankScreen />}>
            <ExecutorPluginsProvider plugins={clientPlugins}>
              <OrganizationProvider
                organizationId={auth.organization.id}
                organizationSlug={scopeSlug}
              >
                {/* Canonicalize onto the URL's org, not the auth org: on first
                    paint `auth.organization` is the SSR hint (the COOKIE's
                    org), and canonicalizing onto that would rewrite a
                    multi-org user's /<orgB> URL to /<orgA> during the hint
                    window. `scopeSlug` prefers the URL slug, so a slugged URL
                    is already canonical (a foreign slug 404'd above) and only
                    a bare URL gets rewritten — onto the auth org, the one
                    thing it can mean. */}
                <OrgSlugGate activeSlug={scopeSlug}>
                  <ArtifactRendererProvider loader={artifactRendererLoader}>
                    <Shell />
                  </ArtifactRendererProvider>
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
