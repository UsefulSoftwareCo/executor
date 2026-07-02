import { createRootRoute } from "@tanstack/react-router";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { LocalAuthGate } from "@executor-js/react/api/local-auth";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { Toaster } from "@executor-js/react/components/sonner";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
import { Shell } from "../web/shell";

export const Route = createRootRoute({
  component: RootComponent,
});

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
