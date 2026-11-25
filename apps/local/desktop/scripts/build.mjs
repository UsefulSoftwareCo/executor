import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildDesktop({ release = false } = {}) {
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  await build({
    entryPoints: {
      main: `${desktop}/src/main.ts`,
      starter: `${desktop}/src/starter.ts`,
      "preload-host": `${desktop}/src/preload-host.ts`,
      "preload-app": `${desktop}/src/preload-app.ts`,
      "preload-menu": `${desktop}/src/preload-menu.ts`,
    },
    outdir: `${desktop}/dist`,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    loader: { ".png": "dataurl" },
    sourcemap: true,
    define: release ? { "process.env.EXECUTOR_DESKTOP_DEV": '"0"' } : {},
  });
  if (process.platform === "darwin")
    execFileSync("clang", [
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=11.0",
      "-Os",
      "-Wall",
      "-Werror",
      "-framework",
      "CoreFoundation",
      "-o",
      `${desktop}/dist/launcher-stub`,
      `${desktop}/assets/launcher-stub.c`,
    ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await buildDesktop({ release: process.argv.includes("--release") });
