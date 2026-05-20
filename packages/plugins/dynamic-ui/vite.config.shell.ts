import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { build } from "esbuild";

function innerRendererSourcePlugin(): Plugin {
  const publicId = "virtual:executor-inner-renderer";
  const resolvedId = `\0${publicId}`;

  return {
    name: "executor-inner-renderer-source",
    resolveId(id) {
      return id === publicId ? resolvedId : undefined;
    },
    async load(id) {
      if (id !== resolvedId) return undefined;

      const result = await build({
        entryPoints: [path.resolve(__dirname, "src/shell/inner-renderer.tsx")],
        absWorkingDir: __dirname,
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        define: {
          "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
        },
      });

      const js = result.outputFiles[0];
      if (!js) throw new Error("Failed to bundle inner renderer.");
      return `export default ${JSON.stringify(js.text)};`;
    },
  };
}

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
