/**
 * Bundle the native entry, and the server starter it runs in a utility process, while keeping
 * Electron's runtime API external, as T3 Code does.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildDesktop() {
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  await build({
    entryPoints: {
      main: `${desktop}/src/main.ts`,
      starter: `${desktop}/src/starter.ts`,
    },
    outdir: `${desktop}/dist`,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop();
