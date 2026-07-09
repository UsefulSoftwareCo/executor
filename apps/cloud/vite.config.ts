import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import executorVitePlugin from "@executor-js/vite-plugin";
import { workerBundlerArtifact } from "@executor-js/plugin-apps/vite";
import { unstable_readConfig } from "wrangler";

import { routes } from "./tsr.routes";

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

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const publicEnv = {
    ...loadWranglerPublicVars(),
    VITE_PUBLIC_ANALYTICS_PATH: ANALYTICS_PATH,
    ...env,
  };
  // The wrangler-declared OTLP endpoint is for DEPLOYED workers (the
  // /v1/traces forwarding route). Under `vite dev` that path is only the
  // proxy below — keep the exporter off unless something actually listens
  // (e2e/dev sets MOTEL_URL or the env var itself), or every dev session
  // posts spans into a dead proxy once a second.
  if (command === "serve" && !process.env.MOTEL_URL && !env.VITE_PUBLIC_OTLP_TRACES_URL) {
    delete (publicEnv as Record<string, string | undefined>).VITE_PUBLIC_OTLP_TRACES_URL;
  }

  // Deps vite only discovers once a lazy-loaded React chunk actually renders
  // (e.g. opening the MCP/OpenAPI "add integration" flow). Discovering them mid-run
  // forces a re-optimize + full program reload; in workerd (apps/cloud's SSR
  // worker) each reload stacks a new isolate's heap on top of the last one
  // without freeing it, so a handful of reloads exhausts the worker's heap
  // limit and crashes the dev server. Pre-bundling them at boot means vite
  // never discovers them mid-run, so it never reloads. Keep this list scoped
  // to deps actually imported by UI code (grep `from "effect/` under
  // packages/react/src and packages/plugins/*/src/react, plus js-yaml pulled
  // in via packages/plugins/openapi/src/sdk) rather than including the world.
  // js-yaml is a transitive dep (via @executor-js/plugin-openapi), not hoisted
  // into apps/cloud/node_modules under bun's isolated install, so a plain
  // "js-yaml" specifier fails to resolve here and silently falls out of the
  // pre-bundle. The "<pkg> > <dep>" syntax resolves it starting from that
  // package's own node_modules instead.
  const lateDiscoveredDeps = [
    "effect/Match",
    "effect/Predicate",
    "effect/Exit",
    "effect/Option",
    "effect/Cause",
    "effect/Data",
    "effect/Schema",
    "@executor-js/plugin-openapi > js-yaml",
  ];

  return {
    define: Object.fromEntries(
      Object.entries(publicEnv)
        .filter(([key]) => key.startsWith("VITE_PUBLIC_"))
        .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
    // Browser OTLP spans (VITE_PUBLIC_OTLP_TRACES_URL=/v1/traces, set by the
    // e2e global setup) go same-origin and proxy to the local motel server —
    // motel serves no CORS headers, so a direct cross-origin post would die
    // in preflight. Dev-only; unrouted when nothing listens.
    server: {
      proxy: {
        "/v1/traces": process.env.MOTEL_URL ?? "http://127.0.0.1:27686",
      },
    },
    resolve: { tsconfigPaths: true },
    // Client-side pre-bundle. See lateDiscoveredDeps comment above.
    optimizeDeps: {
      include: lateDiscoveredDeps,
    },
    // SSR/worker-side pre-bundle for the same deps, keyed under the "ssr"
    // environment name that `cloudflare({ viteEnvironment: { name: "ssr" } })`
    // below uses. The cloudflare plugin sets its own environments.ssr.optimizeDeps
    // (entries/exclude for worker externals); vite merges include arrays rather
    // than replacing them, so this only adds to that, it doesn't fight it.
    environments: {
      ssr: {
        optimizeDeps: {
          include: lateDiscoveredDeps,
        },
      },
    },
    plugins: [
      devCrashGuard(),
      workerBundlerArtifact(),
      tailwindcss(),
      executorVitePlugin(),
      cloudflare({ viteEnvironment: { name: "ssr" }, inspectorPort: false }),
      tanstackStart({
        // The route tree definition lives in tsr.routes.ts (shared with
        // tsr.config.json so `bunx tsr generate` produces the same tree).
        router: {
          virtualRouteConfig: routes,
        },
      }),
      react(),
    ],
  };
});
