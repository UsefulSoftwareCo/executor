import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import executorVitePlugin from "@executor-js/vite-plugin";

import { routes } from "./tsr.routes";
import { MCP_ORIGINAL_PATH_HEADER, stripMcpOrgSegment } from "./src/mcp/org-path";

// The real release version (matches the published `executor` dist-tags the
// update card compares against), read from the CLI package the same way
// apps/local does. A placeholder here made the card read as permanently
// "behind", see the update-check comparison in @executor-js/react.
// oxlint-disable-next-line executor/no-json-parse -- boundary: Vite config reads the version from package.json at build time
const cliPackage = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as { version?: string };
const EXECUTOR_VERSION = cliPackage.version;

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
        let rawUrl = req.url ?? "/";
        // The "Connect an agent" card prints `/<organizationId>/mcp`; self-host
        // serves the bare `/mcp`, so rewrite it here (prod does the same in
        // serve.ts) — otherwise this org-pinned path isn't recognized as an MCP
        // path and falls through to the SPA as a 404. Mirrors ./src/mcp/org-path.
        const devOrigin = `http://${req.headers.host ?? `localhost:${DEV_PORT}`}`;
        const originalPathname = new URL(rawUrl, devOrigin).pathname;
        const pathname = stripMcpOrgSegment(originalPathname) ?? "";
        // Carries the ORIGINAL org-scoped pathname through to the handler (see
        // ./src/mcp/auth.ts) so the protected-resource metadata can echo it
        // back to a client that dialed org-scoped — mirrors serve.ts's prod
        // middleware. Set only when we ourselves rewrote this request; any
        // client-supplied value is dropped below so it can't be spoofed.
        let originalPathHeader: string | null = null;
        if (pathname !== "") {
          const original = new URL(rawUrl, devOrigin);
          rawUrl = `${pathname}${original.search}`;
          originalPathHeader = originalPathname;
        }
        // Match on PATHNAME, not a raw-URL prefix: `/mcp` must NOT swallow the
        // SPA route `/mcp-consent`, or the dev server misroutes it to the API
        // handler and returns a 404.
        const path = new URL(rawUrl, devOrigin).pathname;
        const handled =
          path === "/api" ||
          path.startsWith("/api/") ||
          path === "/mcp" ||
          path.startsWith("/mcp/") ||
          path === "/docs" ||
          path.startsWith("/docs/") ||
          // Un-prefixed app-level routes (e.g. `/v1/app/npm/dist-tags`, which the
          // shell's update check fetches). Served by the Effect router in prod;
          // without this the SPA index.html fallback answers 200-with-HTML and
          // the JSON parse fails, so the UpdateCard never appears.
          path === "/v1" ||
          path.startsWith("/v1/") ||
          // RFC 9728 / RFC 8414 OAuth discovery the MCP client fetches before
          // auth. Served by the Effect router in prod; without this the SPA
          // index.html fallback answers 200-with-HTML and breaks discovery.
          path.startsWith("/.well-known/");
        if (!handled) {
          // SPA document navigations must receive the app shell, not a module.
          // A browser navigating to a route like `/login` (Better Auth's
          // MCP-OAuth `loginPage` 302s here as a real document GET) sends an
          // extensionless request that Vite's transform middleware would resolve
          // to a colliding web-root module (`web/login.tsx` shadows `/login`,
          // `web/setup.tsx` shadows `/setup`) and serve as text/javascript, so
          // the page renders as raw JS and the OAuth login never appears. Rewrite
          // genuine page navigations to the index so Vite's html fallback serves
          // index.html; the SPA reads window.location and renders the right
          // route. Module/asset/HMR requests carry a file extension or a
          // non-document fetch destination, so they fall through untouched. This
          // is dev-only: the production static server already serves index.html
          // for unknown routes, with login/setup bundled into the SPA.
          const isGet = req.method === "GET" || req.method === "HEAD";
          const dest = req.headers["sec-fetch-dest"];
          const accept = req.headers.accept;
          const wantsDocument =
            dest === "document" ||
            (dest === undefined && typeof accept === "string" && accept.includes("text/html"));
          const hasExtension = /\.[^/]+$/.test(path);
          if (isGet && wantsDocument && !hasExtension && !path.startsWith("/@")) {
            req.url = "/";
          }
          return next();
        }

        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Vite dev middleware must convert handler failures into HTTP 500 responses
        try {
          const { handler } = await getHandler();
          const origin = `http://${req.headers.host ?? `localhost:${DEV_PORT}`}`;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          if (originalPathHeader) {
            headers.set(MCP_ORIGINAL_PATH_HEADER, originalPathHeader);
          } else {
            headers.delete(MCP_ORIGINAL_PATH_HEADER);
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
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(EXECUTOR_VERSION ?? "0.0.0"),
    // Self-host upgrades by pulling/rebuilding the image (or git + rebuild), not
    // npm, so the update card links to the upgrade guide instead of a command.
    "import.meta.env.VITE_UPGRADE_HINT": JSON.stringify("selfhost"),
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
      // The route tree definition lives in tsr.routes.ts (shared with
      // packages/react's routes:gen so a CLI regen matches dev/build).
      virtualRouteConfig: routes,
    }),
    ...react(),
  ],
});
