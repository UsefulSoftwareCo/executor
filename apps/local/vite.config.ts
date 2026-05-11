import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import executorVitePlugin from "@executor-js/vite-plugin";

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

/**
 * Vite plugin that forwards /api and /mcp requests to the Effect handlers
 * during development, so you don't need a separate server process.
 */
function executorApiPlugin(): Plugin {
  let handlers: import("./src/server/main").ServerHandlers | null = null;

  return {
    name: "executor-api",
    configureServer(server) {
      server.watcher.on("change", (path) => {
        if (path.includes("/src/server/") || path.endsWith("/executor.config.ts")) {
          handlers = null;
        }
      });
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "/";
        const isApi = rawUrl.startsWith("/api/") || rawUrl === "/api";
        const isMcp = rawUrl.startsWith("/mcp");

        if (!isApi && !isMcp) return next();

        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Vite middleware must convert handler failures into HTTP 500 responses
        try {
          if (!handlers) {
            const { getServerHandlers } = await import("./src/server/main");
            handlers = await getServerHandlers();
          }

          const origin = `http://${req.headers.host ?? "localhost"}`;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }

          // Strip /api prefix for Effect handlers
          const url = isApi ? rawUrl.slice("/api".length) || "/" : rawUrl;

          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const webRequest = new Request(new URL(url, origin), {
            method: req.method,
            headers,
            body: hasBody ? Readable.toWeb(req) : undefined,
            duplex: hasBody ? "half" : undefined,
          } as RequestInit);

          const response = isMcp
            ? await handlers.mcp.handleRequest(webRequest)
            : await handlers.api.handler(webRequest);

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
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(EXECUTOR_VERSION),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify(EXECUTOR_GITHUB_URL),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  server: {
    port: parseInt(process.env.PORT ?? "5173", 10),
    host: "127.0.0.1",
    watch: {
      // Workspace packages live under packages/ and are symlinked into
      // node_modules. Without this, chokidar treats them as ordinary
      // node_modules and skips watching, so edits to e.g.
      // packages/react/src/pages/sources.tsx don't trigger HMR.
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
    tailwindcss(),
    executorVitePlugin(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    ...react(),
    executorApiPlugin(),
  ],
});
