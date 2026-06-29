import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/promise.ts",
    core: "src/index.ts",
    shared: "src/shared.ts",
    "host-internal": "src/host-internal.ts",
    client: "src/client.ts",
    "migration-spec": "src/migration-spec.ts",
    "http-auth": "src/http-auth/index.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^effect/, /^@effect\//, "react"],
});
