/** Keep Node's compiled code for the packaged runtime where only this user can write it. */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The operating system's per-user cache directory, or undefined when the environment names none.
 * XDG ignores a relative `XDG_CACHE_HOME`; a relative path here would land in the working
 * directory.
 */
const userCacheDirectory = () => {
  if (process.platform === "win32") return process.env.LOCALAPPDATA;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
};

/**
 * Node's default cache lives in the shared temporary directory. On Linux another local user can
 * create that directory first and supply compiled code this process would run. This cache lives
 * in the user's own cache directory instead, and stays off unless it is a real directory owned
 * by this user. Turning it off costs only start-up time.
 *
 * It is kept out of the data directory: commands such as `executor pair` must leave that
 * directory exactly as they found it.
 */
export function enablePrivateCompileCache() {
  const base = userCacheDirectory();
  if (base === undefined || !isAbsolute(base)) return;
  const directory = join(base, "executor", "v2", "compile-cache");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // lstat reports a symbolic link itself, which is never a directory.
    const entry = lstatSync(directory);
    if (!entry.isDirectory()) throw new Error("it is not a directory");
    // Windows has no POSIX owner; a profile's local application data is private through its ACLs.
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
