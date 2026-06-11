import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import executorVitePlugin from "@executor-js/vite-plugin";
import { unstable_readConfig } from "wrangler";

// Dev-only: the cloudflare vite-plugin bridges outbound fetches (JWKS,
// OAuth metadata proxy, etc.) through node undici in the host process. If
// a pooled keep-alive socket gets RST'd while no listener is attached, the
// `'error'` emit is unhandled and tears down the whole dev server. Log
// enough to identify the offender and keep the server alive.
const devCrashGuard = (): Plugin => {
  let installed = false;
  const install = () => {
    if (installed) return;
    installed = true;
    process.on("uncaughtException", (err, origin) => {
      console.error(`[dev-crash-guard] uncaughtException (origin=${origin}):`, err);
    });
    process.on("unhandledRejection", (reason, promise) => {
      console.error("[dev-crash-guard] unhandledRejection:", reason, promise);
    });
  };
  return {
    name: "dev-crash-guard",
    apply: "serve",
    configureServer: install,
  };
};

const loadWranglerPublicVars = () => {
  const wranglerConfig = unstable_readConfig(
    { config: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
    { hideWarnings: true },
  );
  return Object.fromEntries(
    Object.entries(wranglerConfig.vars ?? {}).filter(([key]) => key.startsWith("VITE_PUBLIC_")),
  );
};

// VITE_PUBLIC_ANALYTICS_PATH is generated once per build by `scripts/build.mjs`
// and inherited via process.env, so the client and SSR/Cloudflare environment
// builds bake the same value. The fallback "a" is for `vite dev`, where the
// proxy isn't routed anyway.
const ANALYTICS_PATH = process.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const publicEnv = {
    ...loadWranglerPublicVars(),
    VITE_PUBLIC_ANALYTICS_PATH: ANALYTICS_PATH,
    ...env,
  };

  return {
    define: Object.fromEntries(
      Object.entries(publicEnv)
        .filter(([key]) => key.startsWith("VITE_PUBLIC_"))
        .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
    resolve: { tsconfigPaths: true },
    plugins: [
      devCrashGuard(),
      tailwindcss(),
      executorVitePlugin(),
      cloudflare({ viteEnvironment: { name: "ssr" }, inspectorPort: false }),
      tanstackStart({
        // Shared console routes come from @executor-js/react (see its
        // console-routes.ts); cloud owns its root (WorkOS auth + billing
        // shell) and the cloud-specific routes under src/routes/app.
        // Excluded shared paths are intentional divergence: cloud's
        // /secrets redirects to / (credential storage is product plumbing
        // here), its /resume page is the cloud variant, and client plugin
        // pages aren't wired up on cloud.
        router: {
          virtualRouteConfig: rootRoute("__root.tsx", [
            ...consoleRoutes({
              dir: "../../../../packages/react/src/routes",
              exclude: ["/secrets", "/resume/$executionId", "/plugins/$pluginId/$"],
            }),
            physical("", "app"),
          ]),
        },
      }),
      react(),
    ],
  };
});
