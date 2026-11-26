import { resolveEmbeddedGitDir } from "dugite";

export function useBundledGit() {
  process.env.EXECUTOR_GIT_DIRECTORY = resolveEmbeddedGitDir();
}
