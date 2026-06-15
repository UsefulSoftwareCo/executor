/**
 * Stage the production local-server binary for the packaged desktop app.
 *
 * Packaged desktop uses the same compiled `executor` CLI binary as npm installs:
 * the app delegates service install/status/restart to it, and the foreground
 * fallback starts `executor daemon run --foreground`.
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(ROOT, "../..");
const CLI_ROOT = resolve(REPO_ROOT, "apps/cli");
const EXECUTOR_OUT_DIR = resolve(ROOT, "resources/executor");

const platformName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "windows" : platform;

const currentTargetPackage = (): string =>
  `executor-${platformName(process.platform)}-${process.arch}`;

const targetPackageFromBunTarget = (target: string | undefined): string | null => {
  if (!target || target === "bun") return null;
  const normalized = target
    .replace(/^bun-/, "")
    .replace(/^windows-/, "windows-")
    .replace(/^win32-/, "windows-");
  return `executor-${normalized}`;
};

const targetPackage = targetPackageFromBunTarget(process.env.BUN_TARGET) ?? currentTargetPackage();
const targetArgs = process.env.BUN_TARGET ? ["--target", targetPackage] : ["--single"];

console.log(`[build-sidecar] building CLI binary target ${targetPackage}`);
const build = Bun.spawn(["bun", "run", "src/build.ts", "binary", ...targetArgs], {
  cwd: CLI_ROOT,
  stdio: ["ignore", "inherit", "inherit"],
});
if ((await build.exited) !== 0) {
  throw new Error(`CLI binary build failed for ${targetPackage}`);
}

const sourceBinDir = join(CLI_ROOT, "dist", targetPackage, "bin");
await rm(EXECUTOR_OUT_DIR, { recursive: true, force: true });
await mkdir(EXECUTOR_OUT_DIR, { recursive: true });
await cp(sourceBinDir, EXECUTOR_OUT_DIR, { recursive: true });

if (process.platform !== "win32") {
  await chmod(join(EXECUTOR_OUT_DIR, "executor"), 0o755);
}

console.log(`[build-sidecar] staged bundled executor → ${EXECUTOR_OUT_DIR}`);
