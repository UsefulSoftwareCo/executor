/** Bundle the native entry while keeping Electron's runtime API external, as T3 Code does. */
import { fileURLToPath } from "node:url";
import { cp } from "node:fs/promises";
import { build } from "esbuild";

export async function buildDesktop() {
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  await build({
    entryPoints: [`${desktop}/src/main.ts`],
    outfile: `${desktop}/dist/main.cjs`,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
  });
  await cp(`${desktop}/../../../packages/telemetry/dist/motel`, `${desktop}/dist/motel`, {
    recursive: true,
    force: true,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop();
