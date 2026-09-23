/** T3-style macOS development bundle. Only paths and 1Password references enter its launch script. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function resolveLauncher() {
  if (process.platform !== "darwin") return { executable: electron };
  const runtime = join(root, ".local/desktop-runtime");
  const bundle = join(runtime, "Executor Dev.app");
  const executable = join(bundle, "Contents/MacOS/Electron");
  const launcher = join(bundle, "Contents/MacOS/Executor Launcher");
  const electronMetadata = JSON.parse(
    await readFile(new URL("../node_modules/electron/package.json", import.meta.url), "utf8"),
  );
  const revision = `${electronMetadata.version}:2:${root}`;
  let previous;
  try {
    previous = await readFile(join(runtime, "revision"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous !== revision) {
    await mkdir(runtime, { recursive: true });
    await rm(bundle, { recursive: true, force: true });
    // Preserve framework-relative links, as in T3 Code; absolute links break the sandbox and signing.
    await cp(resolve(dirname(electron), "../.."), bundle, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const plist = join(bundle, "Contents/Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleName: "Executor Dev",
      CFBundleDisplayName: "Executor Dev",
      CFBundleIdentifier: `com.usefulsoftware.executor.dev.${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
      CFBundleExecutable: "Executor Launcher",
    })) {
      execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    }
    const script = `#!/bin/sh\nset -eu\nunset ELECTRON_RUN_AS_NODE\ncd ${quote(root)}\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\nexec op run --env-file=.env.development.op -- ${quote(executable)} ${quote(join(root, "apps/local/desktop"))} --dev "$@" >> ${quote(join(root, ".local/desktop.log"))} 2>&1\n`;
    await writeFile(launcher, script, { mode: 0o755 });
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle],
      { stdio: "pipe" },
    );
    await writeFile(join(runtime, "revision"), revision);
  }
  return { executable, bundle };
}
