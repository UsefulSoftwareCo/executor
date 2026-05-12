import { fileURLToPath } from "node:url";
import type { PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import executorVitePlugin from "@executor-js/vite-plugin";

const APP_ROOT = fileURLToPath(new URL("./", import.meta.url));

/**
 * Vite plugin bundle for the executor React app.
 *
 * Layered into apps/local's vite config (for the web build) and
 * apps/desktop's electron.vite renderer config (for the Electron build).
 *
 * Does NOT include consumer-specific defines (VITE_APP_VERSION etc.) or
 * server-side middleware (api/mcp). Consumers layer those on top.
 */
const appPlugin: PluginOption[] = [
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
  executorVitePlugin(),
  tanstackRouter({
    target: "react",
    autoCodeSplitting: true,
    routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
    generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
  }),
  ...react(),
];

export default appPlugin;
