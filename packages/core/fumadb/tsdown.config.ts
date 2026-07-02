import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/schema/index.ts",
    "src/query/index.ts",
    "src/adapters/index.ts",
    "src/cli/index.ts",
    "src/adapters/*/index.ts",
  ],
  format: "esm",
  sourcemap: false,
  dts: true,
  fixedExtension: false,
  target: "es2023",
  exports: true,
  deps: {
    onlyBundle: [],
  },
});
