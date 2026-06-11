import { fileURLToPath } from "node:url";
import type { PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";
import executorVitePlugin from "@executor-js/vite-plugin";

const APP_ROOT = fileURLToPath(new URL("./", import.meta.url));

interface AppPluginOptions {
  /**
   * Absolute path to the `executor.config.ts` whose plugin list should
   * feed `virtual:executor/plugins-client`. The Vite root for this app
   * is `packages/app/` which has no executor.config, so consumers must
   * point this at their own (typically `apps/local/executor.config.ts`).
   *
   * If omitted, no plugin UIs get bundled — the renderer still works
   * for built-in pages but Sources / Connections / etc. plugin pages
   * stay empty.
   */
  readonly executorConfigPath?: string;
  /** Absolute path to `executor.jsonc`. Optional companion to executorConfigPath. */
  readonly executorJsoncPath?: string;
}

/**
 * Vite plugin bundle for the executor React app.
 *
 * Layered into apps/local's vite config (web build) and apps/desktop's
 * electron.vite renderer config. Consumers must pass `executorConfigPath`
 * so plugin client bundles get included — see option docs above.
 *
 * Does NOT include consumer-specific defines (VITE_APP_VERSION etc.) or
 * server-side middleware (api/mcp). Consumers layer those on top.
 */
export default function appPlugin(options: AppPluginOptions = {}): PluginOption[] {
  return [
    {
      name: "executor-app:config",
      config() {
        return {
          resolve: {
            alias: {
              "@executor-app": APP_ROOT,
            },
            dedupe: ["react", "react-dom"],
          },
        };
      },
    },
    tailwindcss(),
    executorVitePlugin({
      ...(options.executorConfigPath ? { configPath: options.executorConfigPath } : {}),
      ...(options.executorJsoncPath ? { jsoncPath: options.executorJsoncPath } : {}),
    }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
      // Shared console routes come from @executor-js/react (see its
      // console-routes.ts); this app owns its root and the local-specific
      // routes under src/routes/app. /secrets is excluded: the local app's
      // variant shows credential-provider info.
      virtualRouteConfig: rootRoute("__root.tsx", [
        ...consoleRoutes({ dir: "../../../react/src/routes", exclude: ["/secrets"] }),
        physical("", "app"),
      ]),
    }),
    ...react(),
  ];
}
