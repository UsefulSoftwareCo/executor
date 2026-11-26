import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const userCacheDirectory = () => {
  if (process.platform === "win32") return process.env.LOCALAPPDATA;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
};

export function enablePrivateCompileCache() {
  const base = userCacheDirectory();
  if (base === undefined || !isAbsolute(base)) return;
  const directory = join(base, "executor", "v2", "compile-cache");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = lstatSync(directory);
    if (!entry.isDirectory()) throw new Error("it is not a directory");
    if (process.platform !== "win32") {
      if (entry.uid !== process.getuid()) throw new Error("another user owns it");
      chmodSync(directory, 0o700);
    }
  } catch (cause) {
    process.emitWarning(`Compiled-code cache is off: ${directory}: ${cause.message}`);
    return;
  }
  enableCompileCache(directory);
}
