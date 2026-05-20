import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.tsx",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//, /^virtual:executor-inner-renderer$/],
  esbuildOptions(options) {
    options.conditions = [...(options.conditions ?? []), "style"];
  },
});
