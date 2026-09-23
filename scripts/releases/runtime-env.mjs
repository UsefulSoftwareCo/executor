/** Resolve packaged native tools at the process boundary, independent of a user's Git install. */
import { delimiter, dirname } from "node:path";
import { resolveEmbeddedGitDir, resolveGitExecPath, setupEnvironment } from "dugite";

/** Preserve the caller's environment while selecting the artifact's Git binary and helper programs. */
export function packagedRuntimeEnvironment(environment) {
  const inherited = Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      process.platform === "win32" ? name.toUpperCase() : name,
      value,
    ]),
  );
  const directory = resolveEmbeddedGitDir();
  const { env, gitLocation } = setupEnvironment(
    {
      LOCAL_GIT_DIRECTORY: directory,
      GIT_EXEC_PATH: resolveGitExecPath(directory, ""),
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
