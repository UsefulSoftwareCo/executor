import React from "react";
import { createRootRoute } from "@tanstack/react-router";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { useExecutorServerConnection } from "@executor-js/react/api/server-connection";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { Button } from "@executor-js/react/components/button";
import { Toaster } from "@executor-js/react/components/sonner";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
import { ServerConnectionMenu } from "../web/server-connection-menu";
import { Shell } from "../web/shell";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ExecutorProvider scopeFailureFallback={<ShellConnectionError />}>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        <Shell />
        <Toaster />
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}

function ShellConnectionError() {
  const connection = useExecutorServerConnection();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
          <span className="shrink-0 font-display text-base tracking-tight text-foreground">
            executor
          </span>
          <div className="ml-auto flex min-w-0 flex-1 justify-end">
            <ServerConnectionMenu variant="header" />
          </div>
        </div>
      </aside>

      <main className="flex min-h-screen flex-1 items-center justify-center px-5 py-8">
        <div className="w-full max-w-md">
          <div className="mb-5 md:hidden">
            <ServerConnectionMenu side="bottom" />
          </div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Server unavailable
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-normal text-foreground">
            Could not connect to Executor
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The selected server did not answer the initial scope request. Switch servers or retry
            this connection.
          </p>
          <code className="mt-4 block rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {connection.origin}
          </code>
          <Button type="button" className="mt-5" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </main>
    </div>
  );
}
