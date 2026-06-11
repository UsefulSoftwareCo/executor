import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";
import executorVitePlugin from "@executor-js/vite-plugin";

// Self-host web SPA. Mirrors @executor-js/app's vite plugin bundle, but points
// the TanStack router codegen at THIS app's routes (web/routes) so we get the
// multiplayer shell + Better-Auth gate (routes/__root.tsx) instead of the
// personal-mode local shell. executorVitePlugin feeds plugin client bundles
// from our executor.config.ts into `virtual:executor/plugins-client`.
const APP_ROOT = fileURLToPath(new URL("../../packages/app/", import.meta.url));
const DEV_PORT = 5173;

// Dev defaults so `bun run dev` boots the full stack with zero manual env.
// Set at module load (before any plugin/executor.config reads them). Override
// via real env for anything you care about (esp. BETTER_AUTH_SECRET in prod).
process.env.EXECUTOR_DATA_DIR ??= fileURLToPath(new URL("./.executor-dev/", import.meta.url));
process.env.BETTER_AUTH_SECRET ??= "executor-selfhost-dev-secret-change-me-0123456789";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL ??= "admin@example.com";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD ??= "executor-dev-admin";
process.env.EXECUTOR_WEB_BASE_URL ??= `http://localhost:${DEV_PORT}`;

// Dev-only: forward /api, /mcp, /docs to the self-host Effect handler in-process
// (the same web handler serve.ts binds). Requires vite to run under Bun
// (`bunx --bun vite dev`) because the handler opens a bun:sqlite DB. No path
// stripping — the self-host API is served under /api by the prefixed router, so
// the handler expects the full path. Handler rebuilds when src/ changes.
function executorApiPlugin(): Plugin {
  let handlerPromise: Promise<{ handler: (request: Request) => Promise<Response> }> | null = null;
  const getHandler = async () => {
    if (!handlerPromise) {
      // Computed specifier so Vite's Node-based config loader does NOT statically
      // follow this into ./src/api/api (which imports @executor-js/host-mcp, whose
      // extensionless re-exports resolve under Bun but not Node ESM). It only runs
      // at dev-server request time, under `bunx --bun vite dev`.
      const apiModule = new URL("./src/api/api.ts", import.meta.url).href;
      handlerPromise = import(apiModule).then((m) => m.makeSelfHostApiHandler());
    }
    return handlerPromise;
  };

  return {
    name: "executor-selfhost-api",
    apply: "serve",
    configureServer(server) {
      server.watcher.on("change", (path) => {
        if (path.includes("/src/") || path.endsWith("/executor.config.ts")) handlerPromise = null;
      });
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "/";
        const handled =
          rawUrl === "/api" ||
          rawUrl.startsWith("/api/") ||
          rawUrl.startsWith("/mcp") ||
          rawUrl.startsWith("/docs") ||
          // RFC 9728 / RFC 8414 OAuth discovery the MCP client fetches before
          // auth. Served by the Effect router in prod; without this the SPA
          // index.html fallback answers 200-with-HTML and breaks discovery.
          rawUrl.startsWith("/.well-known/");
        if (!handled) return next();

        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Vite dev middleware must convert handler failures into HTTP 500 responses
        try {
          const { handler } = await getHandler();
          const origin = `http://${req.headers.host ?? `localhost:${DEV_PORT}`}`;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const webRequest = new Request(new URL(rawUrl, origin), {
            method: req.method,
            headers,
            body: hasBody ? Readable.toWeb(req) : undefined,
            duplex: hasBody ? "half" : undefined,
          } as RequestInit);

          const response = await handler(webRequest);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (response.body) {
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (err) {
          console.error("[executor-selfhost-api]", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        }
      });
    },
  };
}

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
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-selfhost"),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify("https://github.com/RhysSullivan/executor"),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  server: {
    port: DEV_PORT,
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  plugins: [
    executorApiPlugin(),
    tailwindcss(),
    executorVitePlugin({
      configPath: fileURLToPath(new URL("./executor.config.ts", import.meta.url)),
    }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: fileURLToPath(new URL("./web/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./web/routeTree.gen.ts", import.meta.url)),
      // Shared console routes come from @executor-js/react (see its
      // console-routes.ts); this app owns its root (the Better Auth shell)
      // and the self-host-specific routes under web/routes/app (admin,
      // api-keys, invite join).
      virtualRouteConfig: rootRoute("__root.tsx", [
        ...consoleRoutes({ dir: "../../../../packages/react/src/routes" }),
        physical("", "app"),
      ]),
    }),
    ...react(),
  ],
});
