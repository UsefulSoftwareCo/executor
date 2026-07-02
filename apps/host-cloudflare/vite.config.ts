import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import executorVitePlugin from "@executor-js/vite-plugin";

import { routes } from "./tsr.routes";

// The real release version (matches the published `executor` dist-tags the
// update card compares against). A placeholder here made the card read as
// permanently "behind".
// oxlint-disable-next-line executor/no-json-parse -- boundary: Vite config reads the version from package.json at build time
const cliPackage = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as { version?: string };
const EXECUTOR_VERSION = cliPackage.version;

// ---------------------------------------------------------------------------
// Cloudflare web SPA. The SAME shared @executor-js/react shell + pages as cloud
// and self-host; the TanStack router codegen points at THIS app's routes
// (web/routes) so we get the multiplayer shell with the Cloudflare-Access root
// (no in-app login). `vite build` emits a static bundle to ./dist, which
// wrangler serves via Workers Static Assets (see wrangler.jsonc `assets`).
// `executorVitePlugin` feeds plugin client bundles from executor.config.ts into
// `virtual:executor/plugins-client`.
//
// No dev /api middleware here (self-host forwards to an in-process Bun handler);
// on Cloudflare you run `wrangler dev`, which serves the built SPA + the Worker
// API together.
// ---------------------------------------------------------------------------

const APP_ROOT = fileURLToPath(new URL("../../packages/app/", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./web/", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../packages/app/public/", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/", import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: { "@executor-app": APP_ROOT },
    dedupe: ["react", "react-dom"],
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(EXECUTOR_VERSION ?? "0.0.0"),
    // Cloudflare upgrades by redeploying the Worker (wrangler deploy), not npm,
    // so the update card links to the upgrade guide instead of a command.
    "import.meta.env.VITE_UPGRADE_HINT": JSON.stringify("cloudflare"),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify("https://github.com/RhysSullivan/executor"),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  plugins: [
    tailwindcss(),
    executorVitePlugin({
      configPath: fileURLToPath(new URL("./executor.config.ts", import.meta.url)),
    }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: fileURLToPath(new URL("./web/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./web/routeTree.gen.ts", import.meta.url)),
      // The route tree definition lives in tsr.routes.ts (shared with
      // packages/react's routes:gen so a CLI regen matches dev/build).
      virtualRouteConfig: routes,
    }),
    ...react(),
  ],
});
