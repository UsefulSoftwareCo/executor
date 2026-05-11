import React from "react";
import * as Sentry from "@sentry/react";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { AutumnProvider } from "autumn-js/react";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import type { FrontendErrorReporter } from "@executor-js/react/api/error-reporting";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { Toaster } from "@executor-js/react/components/sonner";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
import { AuthProvider, useAuth } from "../web/auth";
import { SupportOptions } from "../web/components/support-options";
import { LoginPage } from "../web/pages/login";
import { OnboardingPage } from "../web/pages/onboarding";
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

export const Route = createRootRoute({
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
    scripts: import.meta.env.DEV ? [{ src: "https://ui.sh/ui-picker.js" }] : [],
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
  return (
    <PostHogProvider client={posthog}>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </PostHogProvider>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar skeleton */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Skeleton className="h-4 w-20" />
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <div className="mt-5 mb-2 px-2.5">
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="flex flex-col gap-1">
            <Skeleton className="h-7 w-11/12 rounded-md" />
            <Skeleton className="h-7 w-10/12 rounded-md" />
            <Skeleton className="h-7 w-9/12 rounded-md" />
          </div>
        </nav>
        <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
      </aside>

      {/* Main content skeleton */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-4 w-20" />
          <div className="w-7 shrink-0" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
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

  if (auth.status === "loading") {
    return <ShellSkeleton />;
  }

  if (auth.status === "unauthenticated") {
    return <LoginPage />;
  }

  if (auth.organization == null) {
    return <OnboardingPage />;
  }

  return (
    <AutumnProvider pathPrefix="/api/autumn">
      <Sentry.ErrorBoundary fallback={<ShellErrorFallback />} showDialog={false}>
        <ExecutorProvider fallback={<ShellSkeleton />} onHandledError={captureFrontendError}>
          <ExecutorPluginsProvider plugins={clientPlugins}>
            <Shell />
            <Toaster />
          </ExecutorPluginsProvider>
        </ExecutorProvider>
      </Sentry.ErrorBoundary>
    </AutumnProvider>
  );
}
