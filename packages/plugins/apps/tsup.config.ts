import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    api: "src/api.ts",
    "seams/index": "src/seams/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//, /^@modelcontextprotocol\//, "esbuild"],
});
