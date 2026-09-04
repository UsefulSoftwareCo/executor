import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "src/client.ts",
  },
  format: ["esm"],
  dts: {
    resolve: true,
  },
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
  noExternal: ["@executor-js/sdk/shared"],
});
