/** Resolve packaged native tools at the process boundary, independent of a user's Git install. */
import { delimiter, dirname } from "node:path";
import { resolveEmbeddedGitDir, resolveGitExecPath, setupEnvironment } from "dugite";

/**
 * Preserve the caller's environment while selecting the artifact's Git binary and helper programs.
 * `gitDirectory` is the bundled Git: dugite's own copy by default, or the copy beside a release
 * executable, whose bundled dugite cannot locate it from its module path.
 */
export function packagedRuntimeEnvironment(environment, gitDirectory = resolveEmbeddedGitDir()) {
  const inherited = Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      process.platform === "win32" ? name.toUpperCase() : name,
      value,
    ]),
  );
  const { env, gitLocation } = setupEnvironment(
    {
      LOCAL_GIT_DIRECTORY: gitDirectory,
      GIT_EXEC_PATH: resolveGitExecPath(gitDirectory, ""),
    },
    inherited,
  );
  return {
    ...env,
    PATH: [dirname(gitLocation), env.PATH]
      .filter((value) => value !== undefined && value !== "")
      .join(delimiter),
  };
}
