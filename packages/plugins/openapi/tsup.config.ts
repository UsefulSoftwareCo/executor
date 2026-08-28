import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/promise.ts",
    core: "src/sdk/index.ts",
    client: "src/react/plugin-client.tsx",
    "providers/google": "src/providers/google/index.ts",
    "providers/microsoft": "src/providers/microsoft/index.ts",
    testing: "src/testing/index.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
