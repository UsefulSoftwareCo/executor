import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/promise.ts",
    core: "src/index.ts",
    shared: "src/shared.ts",
    client: "src/client.ts",
    testing: "src/testing.ts",
    "vendor/json-schema-to-typescript/index": "src/vendor/json-schema-to-typescript/index.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^effect/, /^@effect\//, "react"],
});
