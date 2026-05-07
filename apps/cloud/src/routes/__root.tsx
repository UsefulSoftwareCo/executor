import React from "react";
import * as Sentry from "@sentry/react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { AuthProvider, useAuth } from "../web/auth";
import { LoginPage } from "../web/pages/login";
import { OnboardingPage } from "../web/pages/onboarding";
import { ShellSkeleton } from "../web/shell";
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
  });
}

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

function AuthGate() {
  const auth = useAuth();

  if (auth.status === "loading") {
    return <ShellSkeleton />;
  }

  if (auth.status === "unauthenticated") {
    return <LoginPage />;
  }

  if (auth.organizations.length === 0) {
    return <OnboardingPage />;
  }

  return <Outlet />;
}
