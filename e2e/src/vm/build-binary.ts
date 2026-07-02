// Build the compiled `executor` for a guest os/arch. `service install` refuses
// to run from a dev (.ts) entrypoint, so the VM targets need a real binary —
// produced via the `--target` flag on apps/cli/src/build.ts.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { VmArch, VmOs } from "./types";

const execFileP = promisify(execFile);

const PLATFORM_TAG: Record<VmOs, string> = { macos: "darwin", linux: "linux", windows: "windows" };

// e2e/src/vm/build-binary.ts → repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_DIR = path.join(REPO_ROOT, "apps", "cli");

/**
 * Build the `executor` binary for a guest and return its `bin` directory
 * (executor[.exe] + the native libsql/keyring modules). The build cleans
 * `dist/` each run, so callers should push the result before building another.
 */
export const buildGuestBinary = async (os: VmOs, arch: VmArch): Promise<string> => {
  const target = `executor-${PLATFORM_TAG[os]}-${arch}`;
  await execFileP("bun", ["run", "src/build.ts", "binary", "--target", target], {
    cwd: CLI_DIR,
    maxBuffer: 256 * 1024 * 1024,
  });
  const binDir = path.join(CLI_DIR, "dist", target, "bin");
  const exe = path.join(binDir, os === "windows" ? "executor.exe" : "executor");
  if (!existsSync(exe)) throw new Error(`buildGuestBinary: ${exe} not produced`);
  return binDir;
};
