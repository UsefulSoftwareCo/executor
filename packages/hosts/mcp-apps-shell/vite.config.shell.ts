import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

import { innerRendererPlugin, tailwindBrowserSourcePlugin } from "./src/vite";

// The standalone shell build and the app builds that embed the shell must
// produce the SAME inner-renderer bytes, so both go through the one plugin
// exported from `./src/vite` (`@executor-js/mcp-apps-shell/vite`).
const innerRendererSourcePlugin = (): Plugin => innerRendererPlugin() as Plugin;
const tailwindSourcePlugin = (): Plugin => tailwindBrowserSourcePlugin() as Plugin;

export default defineConfig({
  plugins: [
    innerRendererSourcePlugin(),
    tailwindSourcePlugin(),
    react(),
    tailwindcss(),
    viteSingleFile(),
  ],
  root: path.resolve(__dirname, "src/shell"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: false,
    // Inline the vendored Geist faces as `data:` URLs rather than emitting them
    // as sibling files. The shell must be ONE self-contained document (it is
    // served as a `ui://` resource with no origin to resolve siblings against),
    // and the inner renderer's CSP is `font-src data:` — a URL reference would
    // be blocked and the artifact would fall back to system-ui. The default
    // 4 kB limit is far below the ~25 kB subsets, so it is raised past them.
    assetsInlineLimit: 96 * 1024,
    rollupOptions: {
      input: path.resolve(__dirname, "src/shell/mcp-app.html"),
    },
  },
  resolve: {
    alias: {
      // Ensure consistent React resolution
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
});
