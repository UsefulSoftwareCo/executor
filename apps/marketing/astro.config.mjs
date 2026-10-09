// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { apiOrigin, siteOrigin } from "./src/content/site-origin.ts";
import { assetsInlineLimit } from "./src/script-assets.ts";

// The marketing pages are built as static files. The parent application owns
// auth and product routing at /login and /app respectively.
export default defineConfig({
  site: siteOrigin,
  output: "static",
  integrations: [react()],
  vite: {
    // The Apps pages read the registry in the browser, from the deployment's API host.
    define: { "import.meta.env.PUBLIC_EXECUTOR_API_ORIGIN": JSON.stringify(apiOrigin) },
    build: { sourcemap: "hidden", assetsInlineLimit },
    plugins: [
      tailwindcss(),
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
});
