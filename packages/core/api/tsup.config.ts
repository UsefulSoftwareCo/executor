import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "src/client.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//],
});
