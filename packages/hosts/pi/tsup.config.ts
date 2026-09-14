import { defineConfig } from "tsup";

export default defineConfig({
  // Pi discovers extensions from the directories named in package.json's `pi`
  // key, so the built entry has to land inside `dist/extensions/`.
  entry: { "extensions/executor": "src/extension.ts" },
  format: ["esm"],
  // Declarations are emitted to `dist/types` by a separate tsc pass, NOT here.
  // Pi loads every file in an extensions directory whose name ends in `.ts` or
  // `.js` (pi-coding-agent, core/package-manager.js: `entry.name.endsWith(".ts")
  // || entry.name.endsWith(".js")`), and `executor.d.ts` ends in `.ts` — it
  // would be picked up and loaded as a second, broken extension.
  dts: false,
  clean: true,
  sourcemap: true,
  // Pi bundles these itself and requires them as `"*"` peers.
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"],
});
