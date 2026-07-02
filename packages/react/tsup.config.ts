import { defineConfig } from "tsup";

// Only console-routes gets built: it is imported by app vite configs, which
// vite's config loader runs under Node (it externalizes bare package imports,
// and Node cannot load raw .ts). Everything else this package exports is
// browser code compiled from src by each app's vite build. Same pattern as
// @executor-js/vite-plugin.
export default defineConfig({
  entry: {
    "console-routes": "src/console-routes.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@tanstack\//],
});
