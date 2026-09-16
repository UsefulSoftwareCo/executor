import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    api: "src/api.ts",
    client: "src/client.tsx",
    testing: "src/fixture.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor-js\//, /^effect/, /^@effect\//, /^react/, "saxes"],
});
