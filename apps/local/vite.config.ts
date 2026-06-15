import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import appPlugin from "@executor-js/app/vite";
import { loadOrMintLocalAuthToken } from "./src/auth";
import { consumeOAuthResult } from "./src/oauth-result-store";
import { isUnauthenticatedOAuthCallbackPath, makeIsAuthorized } from "./src/serve-shared";

// oxlint-disable-next-line executor/no-json-parse -- boundary: Vite config reads package metadata from package.json
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string; homepage?: string; repository?: string | { url?: string } };

// oxlint-disable-next-line executor/no-json-parse -- boundary: Vite config reads package metadata from package.json
const cliPackage = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as { version?: string };

const repositoryUrl =
  typeof rootPackage.repository === "string" ? rootPackage.repository : rootPackage.repository?.url;

const EXECUTOR_VERSION = cliPackage.version ?? rootPackage.version;
const EXECUTOR_GITHUB_URL = (
  rootPackage.homepage ??
  repositoryUrl ??
  "https://github.com/RhysSullivan/executor"
)
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("../../packages/app/", import.meta.url));

/**
 * Vite plugin that forwards /api and /mcp requests to the Effect handlers
 * during development, so you don't need a separate server process.
 */
function executorApiPlugin(): Plugin {
  let handlers: import("./src/main").ServerHandlers | null = null;
  // The dev server's in-process /api + /mcp require the bearer (same gate as the
  // production Bun shell). The browser gets the token the SAME way it does in
  // production — via the one-time `?_token=` URL printed below — so there is no
  // dev-only token-injection path to drift.
  let devToken: string | null = null;

  return {
    name: "executor-api",
    configureServer(server) {
      devToken ??= loadOrMintLocalAuthToken();

      // Print the bootstrap URL when vite is the front (plain `bun run dev`).
      // When the CLI daemon spawns vite as a child (EXECUTOR_DEV_VITE_PORT set),
      // the daemon prints its own `?_token=` URL and the app is loaded from the
      // daemon port, so we stay quiet to avoid two conflicting URLs.
      if (!process.env.EXECUTOR_DEV_VITE_PORT) {
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const port =
            typeof address === "object" && address ? address.port : server.config.server.port;
          server.config.logger.info(
            `\n  Open with auth:  http://127.0.0.1:${port}/?_token=${devToken}\n`,
          );
        });
      }

      server.watcher.on("change", (path) => {
        if (path.includes("/apps/local/src/") || path.endsWith("/executor.config.ts")) {
          handlers = null;
        }
      });
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "/";
        const isApi = rawUrl.startsWith("/api/") || rawUrl === "/api";
        const isMcp = rawUrl.startsWith("/mcp");

        if (!isApi && !isMcp) return next();

        // Gate parity with the production Bun shell (serve.ts): the vite server
        // is reachable by any local process, so /api and /mcp require the bearer
        // here too — otherwise /mcp would be unauthenticated arbitrary code
        // execution in dev. Exempt the health probe and the state-gated OAuth
        // callback. The SPA carries the token from its `?_token`/localStorage
        // bootstrap, so the UI is unaffected; external MCP clients use the
        // daemon port.
        const pathOnly = rawUrl.split("?")[0] ?? "/";
        const authExempt =
          pathOnly === "/api/health" || isUnauthenticatedOAuthCallbackPath(pathOnly);
        if (!authExempt) {
          const presented = req.headers.authorization;
          const authValue = Array.isArray(presented) ? presented[0] : presented;
          const probe = new Request(
            "http://localhost/",
            authValue ? { headers: { authorization: authValue } } : undefined,
          );
          if (!makeIsAuthorized(devToken ?? loadOrMintLocalAuthToken())(probe)) {
            res.statusCode = 401;
            res.setHeader("www-authenticate", 'Bearer realm="executor"');
            res.end("Unauthorized");
            return;
          }
        }

        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Vite middleware must convert handler failures into HTTP 500 responses
        try {
          if (!handlers) {
            const { getServerHandlers } = await import("./src/main");
            handlers = await getServerHandlers(devToken ?? loadOrMintLocalAuthToken());
          }

          const origin = `http://${req.headers.host ?? "localhost"}`;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }

          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const webRequest = (url: string): Request =>
            new Request(new URL(url, origin), {
              method: req.method,
              headers,
              body: hasBody ? Readable.toWeb(req) : undefined,
              duplex: hasBody ? "half" : undefined,
            } as RequestInit);

          let response: Response;
          if (isMcp) {
            response = await handlers.mcp.handleRequest(webRequest(rawUrl));
          } else if (pathOnly === "/api/health" && req.method === "GET") {
            response = new Response("ok", { headers: { "content-type": "text/plain" } });
          } else if (pathOnly.startsWith("/api/mcp-sessions/")) {
            const handler =
              req.method === "GET"
                ? handlers.mcp.handlePausedRequest
                : handlers.mcp.handleApprovalRequest;
            response = await handler(webRequest(rawUrl));
          } else {
            const awaitMatch = /^\/api\/oauth\/await\/([^/?#]+)$/.exec(pathOnly);
            if (awaitMatch && req.method === "GET") {
              response = new Response(JSON.stringify(consumeOAuthResult(awaitMatch[1]!)), {
                headers: { "content-type": "application/json" },
              });
            } else {
              // Strip /api prefix for Effect handlers.
              response = await handlers.api.handler(webRequest(rawUrl.slice("/api".length) || "/"));
            }
          }

          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));

          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (err) {
          console.error("[executor-api]", err);
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
  root: APP_ROOT,
  publicDir: resolve(APP_ROOT, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(EXECUTOR_VERSION),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify(EXECUTOR_GITHUB_URL),
    "import.meta.env.VITE_EXECUTOR_DEV_CLI_CWD": JSON.stringify(REPO_ROOT),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: parseInt(process.env.PORT ?? "5173", 10),
    host: "127.0.0.1",
    // When the CLI daemon spawns this vite as a child and proxies HTTP
    // (EXECUTOR_DEV=1), the page is loaded from the daemon's port, but
    // the daemon does not proxy WebSockets. Point the HMR client at
    // vite's own port so the browser opens a WS directly to vite, side-
    // stepping the daemon proxy. Without this, the client tries the
    // daemon port and floods the console with reconnect errors.
    hmr: process.env.EXECUTOR_DEV_VITE_PORT
      ? {
          host: "127.0.0.1",
          clientPort: parseInt(process.env.EXECUTOR_DEV_VITE_PORT, 10),
          protocol: "ws",
        }
      : undefined,
    watch: {
      // Workspace packages live under packages/ and are symlinked into
      // node_modules. Without this, chokidar treats them as ordinary
      // node_modules and skips watching, so edits to e.g.
      // packages/react/src/pages/integrations.tsx don't trigger HMR.
      ignored: ["!**/node_modules/@executor-js/**"],
      // WSL2 + symlinked workspace packages can drop inotify events;
      // polling is slower but reliable.
      usePolling: true,
      interval: 200,
    },
    fs: {
      allow: [resolve(import.meta.dirname, "../..")],
    },
  },
  plugins: [
    appPlugin({
      executorConfigPath: resolve(import.meta.dirname, "executor.config.ts"),
      executorJsoncPath: resolve(import.meta.dirname, "executor.jsonc"),
    }),
    executorApiPlugin(),
  ],
});
