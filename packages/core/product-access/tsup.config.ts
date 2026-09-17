import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    policy: "src/policy.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
