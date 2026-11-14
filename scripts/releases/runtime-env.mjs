/** Name the packaged Git to the Executor server, independent of a user's Git install. */
import { resolveEmbeddedGitDir } from "dugite";

/**
 * Point the server at the Git this package bundles, dugite's own copy. Only the server's Git host
 * runs it, with the environment it needs; processes Executor starts for other purposes keep the
 * caller's PATH and Git.
 */
export function useBundledGit() {
  process.env.EXECUTOR_GIT_DIRECTORY = resolveEmbeddedGitDir();
}
