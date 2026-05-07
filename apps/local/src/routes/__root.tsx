import React from "react";
import { createRootRoute } from "@tanstack/react-router";
import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";
import { LocalNavTargets } from "../web/nav-targets";
import { Shell } from "../web/shell";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ExecutorProvider>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        <LocalNavTargets>
          <Shell />
        </LocalNavTargets>
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}
