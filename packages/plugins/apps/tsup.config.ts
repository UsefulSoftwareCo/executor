import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    api: "src/api.ts",
    authoring: "src/authoring.ts",
    "testing/index": "src/testing/index.ts",
    vite: "src/vite.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//, "esbuild", "zod", "vite"],
});
