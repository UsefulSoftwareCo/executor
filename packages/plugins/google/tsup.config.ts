import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/promise.ts",
    core: "src/sdk/index.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
