import { sentryVitePlugin } from "@sentry/vite-plugin";
import { dashboardViteConfig } from "@executor-js/hosted-web/vite";
import { mergeConfig } from "vite-plus";
import { browserOnlySettings } from "./browser-only-settings.ts";
import { cloudflareRoutes } from "./cloudflare-routes.ts";
import { cloudReleaseNotes } from "./release-notes.ts";

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
        resolve: { external: ["effect"] },
      },
    },
    server: { proxy: { "/docs": apiUrl } },
    build: { sourcemap: "hidden" },
    plugins: [
      cloudflareRoutes(),
      cloudReleaseNotes(),
      ...(process.env.SENTRY_RELEASE
        ? [
            sentryVitePlugin({
              telemetry: false,
              errorHandler: (error) => {
                throw error;
              },
              release: { inject: false },
              sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
            }),
          ]
        : []),
    ],
  },
);
