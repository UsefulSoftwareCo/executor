import { createRootRoute } from "@tanstack/react-router";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { LocalAuthGate } from "@executor-js/react/api/local-auth";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { Toaster } from "@executor-js/react/components/sonner";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
import { Shell } from "../web/shell";

export const Route = createRootRoute({
  notFoundComponent: NotFoundPage,
  component: RootComponent,
});

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

function RootComponent() {
  return (
    <ExecutorProvider>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        <LocalAuthGate>
          <Shell />
        </LocalAuthGate>
        <Toaster />
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}
