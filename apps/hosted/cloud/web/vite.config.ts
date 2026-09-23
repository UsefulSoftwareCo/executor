import { sentryVitePlugin } from "@sentry/vite-plugin";
import { dashboardViteConfig } from "@executor-js/hosted-web/vite";
import { mergeConfig } from "vite-plus";
import { cloudflareRedirects } from "./cloudflare-redirects.ts";

const redirects = cloudflareRedirects();
const apiUrl = process.env.HOSTED_API_URL ?? "http://127.0.0.1:4411";

export default mergeConfig(
  dashboardViteConfig({
    apiUrl,
    port: 4412,
    routePlugins: [redirects.routes],
  }),
  {
    // Cloud's IaC serves documentation beside the dashboard on every stage.
    define: { "import.meta.env.VITE_EXECUTOR_DOCS_BASE_URL": JSON.stringify("/docs/") },
    // The development dashboard delegates docs to the Worker's built static assets.
    server: { proxy: { "/docs": apiUrl } },
    build: { sourcemap: "hidden" },
    plugins: [
      redirects.assets,
      ...(process.env.SENTRY_AUTH_TOKEN
        ? [
            sentryVitePlugin({
              telemetry: false,
              sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
            }),
          ]
        : []),
    ],
  },
);
