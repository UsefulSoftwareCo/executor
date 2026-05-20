import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/promise.ts",
    core: "src/index.ts",
    shared: "src/shared.ts",
    "http-source": "src/http-source.ts",
    client: "src/client.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^effect/, /^@effect\//, "react"],
});
