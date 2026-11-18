/**
 * Bundle the native entry, and the server starter it runs in a utility process, while keeping
 * Electron's runtime API external, as T3 Code does. `--release` builds what the release packages:
 * like the CLI's release bundles it defines EXECUTOR_DESKTOP_DEV as "0", which leaves the desktop's
 * development-only code out of the bundle.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildDesktop({ release = false } = {}) {
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
    define: release ? { "process.env.EXECUTOR_DESKTOP_DEV": '"0"' } : {},
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await buildDesktop({ release: process.argv.includes("--release") });
