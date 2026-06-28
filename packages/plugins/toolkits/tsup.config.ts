import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    client: "src/client.tsx",
    shared: "src/shared.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["react"],
});
