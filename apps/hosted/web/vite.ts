/** Shared build tooling. Each dashboard supplies its own root, routes, and API target. */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import type { Config } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";

/** Configure a host's SPA without importing another host's frontend. */
export const dashboardViteConfig = ({
  apiUrl,
  port,
  routePlugins = [],
}: {
  readonly apiUrl: string;
  readonly port: number;
  readonly routePlugins?: Config["plugins"];
}) =>
  defineConfig({
    publicDir: fileURLToPath(new URL("./public", import.meta.url)),
    plugins: [
      {
        name: "executor-build-metadata",
        transformIndexHtml: () => [
          {
            tag: "meta",
            attrs: {
              name: "executor-build",
              content: process.env.EXECUTOR_BUILD_VERSION ?? "development",
            },
            injectTo: "head" as const,
          },
          {
            tag: "meta",
            attrs: {
              name: "executor-environment",
              content: process.env.EXECUTOR_ENVIRONMENT ?? "development",
            },
            injectTo: "head" as const,
          },
        ],
      },
      tanstackRouter({
        routesDirectory: "./src/implementation/routes",
        generatedRouteTree: "./src/implementation/routeTree.gen.ts",
        autoCodeSplitting: true,
        codeSplittingOptions: {
          splitBehavior: ({ routeId }) => (routeId === "/org/$organizationSlug" ? [] : undefined),
        },
        plugins: routePlugins,
      }),
      react(),
      tailwindcss(),
    ],
    build: { outDir: "dist" },
    server: {
      host: "127.0.0.1",
      port: process.env.PORT === undefined ? port : Number(process.env.PORT),
      strictPort: true,
      proxy: {
        "/api": apiUrl,
        "/health": apiUrl,
        "/openapi.json": apiUrl,
        "^/mcp$": apiUrl,
        "^/org/[^/]+/mcp$": apiUrl,
        "/.well-known": apiUrl,
      },
    },
  });
