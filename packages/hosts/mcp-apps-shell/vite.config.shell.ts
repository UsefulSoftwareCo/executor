import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

import { innerRendererPlugin } from "./src/vite";

// The standalone shell build and the app builds that embed the shell must
// produce the SAME inner-renderer bytes, so both go through the one plugin
// exported from `./src/vite` (`@executor-js/mcp-apps-shell/vite`).
const innerRendererSourcePlugin = (): Plugin => innerRendererPlugin() as Plugin;

export default defineConfig({
  plugins: [innerRendererSourcePlugin(), react(), tailwindcss(), viteSingleFile()],
  root: path.resolve(__dirname, "src/shell"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: false,
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
