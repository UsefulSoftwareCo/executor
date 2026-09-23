import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";

// T3 Code uses bundled development to avoid cold ESM import waterfalls.
const desktopDevelopment = process.env.EXECUTOR_DESKTOP_DEV === "1";
const tailwind = tailwindcss();
if (desktopDevelopment) {
  // Rolldown tracks addWatchFile dependencies; this Vite-only hook expects ModuleNodes.
  for (const plugin of tailwind) delete plugin.hotUpdate;
}

export default defineConfig({
  experimental: { bundledDev: desktopDevelopment },
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
    }),
    react(),
    tailwind,
  ],
});
