import { sentryVitePlugin } from "@sentry/vite-plugin";
import { dashboardViteConfig } from "@executor-js/hosted-web/vite";
import { mergeConfig } from "vite-plus";
import { browserOnlySettings } from "./browser-only-settings.ts";
import { cloudflareRoutes } from "./cloudflare-routes.ts";

const apiUrl = process.env.HOSTED_API_URL ?? "http://127.0.0.1:4411";

export default mergeConfig(
  dashboardViteConfig({
    apiUrl,
    port: 4412,
  }),
  {
    environments: {
      ssr: {
        define: Object.fromEntries(
          browserOnlySettings.map((name) => [`import.meta.env.${name}`, "undefined"]),
        ),
      },
    },
    // The development dashboard delegates docs to the Worker's built static assets.
    server: { proxy: { "/docs": apiUrl } },
    build: { sourcemap: "hidden" },
    plugins: [
      cloudflareRoutes(),
      // The stack sets a release only for stages that report to Sentry. Every such build injects
      // the same code; only a build holding the upload token sends its source maps.
      ...(process.env.SENTRY_RELEASE
        ? [
            sentryVitePlugin({
              telemetry: false,
              // The plugin only logs a failed release or source map upload unless this throws. A
              // deploy must stop instead: production errors would arrive without readable stacks.
              errorHandler: (error) => {
                throw error;
              },
              // Naming the release in every file would rename every file on every deploy. Events
              // carry the release from the document, and source maps match by debug ID.
              release: { inject: false },
              sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
            }),
          ]
        : []),
    ],
  },
);
