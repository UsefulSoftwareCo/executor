import { fileURLToPath } from "node:url";
import { dashboardStartPlugins } from "@executor-js/dashboard-start/vite";
import { defineConfig } from "vite-plus";

export const dashboardViteConfig = ({
  apiUrl,
  port,
}: {
  readonly apiUrl: string;
  readonly port: number;
}) =>
  defineConfig({
    publicDir: fileURLToPath(new URL("./public", import.meta.url)),
    plugins: dashboardStartPlugins({
      runtime: "workerd",
      router: {
        codeSplittingOptions: {
          splitBehavior: ({ routeId }) => (routeId === "/org/$organizationSlug" ? [] : undefined),
        },
      },
    }),
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
