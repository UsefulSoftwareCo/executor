/* oxlint-disable executor/no-try-catch-or-throw, executor/no-promise-catch -- boundary: auto-commit coordinates sandbox, GitHub, and AI SDK Promise APIs into a stable result envelope */
import type { Sandbox } from "@open-agents/sandbox";
import {
  getHeadSha,
  hasUncommittedChanges,
  stageAll,
  getCurrentBranch,
  getStagedDiff,
  syncToRemote,
  syncToRemotePreservingChanges,
  withTemporaryGitHubAuth,
} from "@open-agents/sandbox";
import { generateText } from "ai";
import { languageModelSettings } from "@open-agents/model-settings";
import { updateSession } from "@/lib/db/sessions";
import { generateBranchName, isSafeBranchName } from "@/lib/git/helpers";
import {
  mintInstallationToken,
  revokeInstallationToken,
  withScopedInstallationOctokit,
} from "@/lib/github/app";
import { verifyRepoAccess, type RepoAccessResult } from "@/lib/github/access";
import { buildCommitIntentFromSandbox } from "@/lib/github/commit-intent";
import { createCommit, buildCoAuthor } from "@/lib/github/commit";

const commitMessageModel = languageModelSettings("anthropic/claude-haiku-4.5");

export interface AutoCommitParams {
  sandbox: Sandbox;
  userId: string;
  sessionId: string;
  sessionTitle: string;
  repoOwner: string;
  repoName: string;
  /** base branch for new branches that don't exist on remote yet */
  baseBranch?: string;
}

export interface AutoCommitResult {
  committed: boolean;
  pushed: boolean;
  commitMessage?: string;
  commitSha?: string;
  error?: string;
}

/**
 * Performs an auto-commit via the GitHub API (verified/signed commits).
 * Stages changes, generates a commit message, creates the commit via API,
 * then syncs the sandbox to match the new remote HEAD.
 */
export async function performAutoCommit(params: AutoCommitParams): Promise<AutoCommitResult> {
  const { sandbox, userId, sessionId, sessionTitle, repoOwner, repoName, baseBranch } = params;

  // 1. verify repo access and get installation
  const access = await verifyRepoAccess({
    userId,
    owner: repoOwner,
    repo: repoName,
    requiredUserPermission: "write",
  });

  if (!access.ok) {
    return {
      committed: false,
      pushed: false,
      error: `Cannot commit: ${access.reason}`,
    };
  }

  const resolvedBaseBranch = baseBranch ?? access.defaultBranch;
  let branch = await getCurrentBranch(sandbox);

  if (!isSafeBranchName(branch) || branch === "HEAD") {
    return {
      committed: false,
      pushed: false,
      error: "Current branch is not supported for auto-commit",
    };
  }

  const hasChanges = await hasUncommittedChanges(sandbox);
  if (!hasChanges) {
    return pushCommittedBranch({
      access,
      branch,
      baseBranch: resolvedBaseBranch,
      sandbox,
      sessionId,
    });
  }

  if (branch === resolvedBaseBranch) {
    branch = generateBranchName("agent");
    const checkoutResult = await sandbox.exec(
      `git checkout -b ${branch}`,
      sandbox.workingDirectory,
      10000,
    );
    if (!checkoutResult.success) {
      return {
        committed: false,
        pushed: false,
        error: `Failed to create branch: ${checkoutResult.stdout}`,
      };
    }
    await updateSession(sessionId, { branch }).catch(() => {});
  }

  try {
    if (access.authStrategy === "user-token") {
      await withTemporaryGitHubAuth(sandbox, access.token, () =>
        syncToRemotePreservingChanges(sandbox, branch),
      );
    } else {
      const syncToken = await mintInstallationToken({
        installationId: access.installationId,
        repositoryIds: [access.repositoryId],
        permissions: { contents: "read" },
      });
      try {
        await withTemporaryGitHubAuth(sandbox, syncToken.token, () =>
          syncToRemotePreservingChanges(sandbox, branch),
        );
      } finally {
        await revokeInstallationToken(syncToken.token);
      }
    }
  } catch (error) {
    console.warn(`[auto-commit] Pre-commit sandbox sync failed for session ${sessionId}:`, error);
    return {
      committed: false,
      pushed: false,
      error: "Failed to sync latest remote changes before committing",
    };
  }

  // 2. stage all changes
  try {
    await stageAll(sandbox);
  } catch {
    return {
      committed: false,
      pushed: false,
      error: "Failed to stage changes",
    };
  }

  // 3. generate commit message from staged diff
  const commitMessage = await generateCommitMessage(sandbox, sessionTitle);

  if (access.authStrategy === "user-token") {
    const commitResult = await withTemporaryGitHubAuth(sandbox, access.token, async () => {
      const messageArg = JSON.stringify(commitMessage);
      const commit = await sandbox.exec(
        `git commit -m ${messageArg}`,
        sandbox.workingDirectory,
        60000,
      );
      if (!commit.success) {
        return { ok: false, error: commit.stdout || commit.stderr } as const;
      }

      const push = await sandbox.exec(
        `GIT_TERMINAL_PROMPT=0 git push -u origin ${branch}`,
        sandbox.workingDirectory,
        60000,
      );
      if (!push.success) {
        return { ok: false, error: push.stdout || push.stderr } as const;
      }

      return { ok: true, commitSha: await getHeadSha(sandbox) } as const;
    });

    if (!commitResult.ok) {
      return {
        committed: false,
        pushed: false,
        error: commitResult.error,
      };
    }

    return {
      committed: true,
      pushed: true,
      commitMessage,
      commitSha: commitResult.commitSha,
    };
  }

  const coAuthor = await buildCoAuthor(userId);

  const intentResult = await buildCommitIntentFromSandbox({
    sandbox,
    owner: repoOwner,
    repo: repoName,
    repositoryId: access.repositoryId,
    installationId: access.installationId,
    branch,
    baseBranch: resolvedBaseBranch,
    message: commitMessage,
    ...(coAuthor ? { coAuthor } : {}),
  });

  if (!intentResult.ok) {
    if (intentResult.empty) {
      return { committed: false, pushed: false };
    }
    return { committed: false, pushed: false, error: intentResult.error };
  }

  // 6. create verified commit via github api
  const result = await withScopedInstallationOctokit({
    installationId: intentResult.intent.installationId,
    repositoryId: intentResult.intent.repositoryId,
    permissions: { contents: "write" },
    operation: async (octokit) =>
      createCommit({
        octokit,
        owner: intentResult.intent.owner,
        repo: intentResult.intent.repo,
        branch: intentResult.intent.branch,
        expectedHeadSha: intentResult.intent.expectedHeadSha,
        message: intentResult.intent.message,
        files: intentResult.intent.files,
        ...(intentResult.intent.baseBranch ? { baseBranch: intentResult.intent.baseBranch } : {}),
        ...(intentResult.intent.coAuthor ? { coAuthor: intentResult.intent.coAuthor } : {}),
      }),
  });

  if (!result.ok) {
    console.warn(`[auto-commit] API commit failed for session ${sessionId}: ${result.error}`);
    return {
      committed: false,
      pushed: false,
      error: result.error,
    };
  }

  // 8. sync sandbox to match the new remote head
  try {
    const syncToken = await mintInstallationToken({
      installationId: intentResult.intent.installationId,
      repositoryIds: [intentResult.intent.repositoryId],
      permissions: { contents: "read" },
    });
    try {
      await withTemporaryGitHubAuth(sandbox, syncToken.token, () => syncToRemote(sandbox, branch));
    } finally {
      await revokeInstallationToken(syncToken.token);
    }
  } catch (error) {
    console.warn(`[auto-commit] Sandbox sync failed for session ${sessionId}:`, error);
    // commit succeeded on remote even if sandbox sync fails
  }

  console.log(`[auto-commit] Successfully committed (verified) for session ${sessionId}`);

  return {
    committed: true,
    pushed: true,
    commitMessage,
    commitSha: result.commitSha,
  };
}

type VerifiedRepoAccess = Extract<RepoAccessResult, { ok: true }>;

async function pushCommittedBranch(params: {
  access: VerifiedRepoAccess;
  baseBranch: string;
  branch: string;
  sandbox: Sandbox;
  sessionId: string;
}): Promise<AutoCommitResult> {
  const { access, baseBranch, branch, sandbox, sessionId } = params;

  if (branch === baseBranch) {
    return { committed: false, pushed: false };
  }

  async function pushWithAuth(token: string): Promise<AutoCommitResult> {
    return withTemporaryGitHubAuth(sandbox, token, async () => {
      await sandbox.exec(
        `git fetch origin ${baseBranch}:refs/remotes/origin/${baseBranch}`,
        sandbox.workingDirectory,
        60000,
      );

      const ahead = await sandbox.exec(
        `git rev-list --count origin/${baseBranch}..HEAD`,
        sandbox.workingDirectory,
        30000,
      );
      if (!ahead.success || Number.parseInt(ahead.stdout.trim(), 10) === 0) {
        return { committed: false, pushed: false };
      }

      const push = await sandbox.exec(
        `GIT_TERMINAL_PROMPT=0 git push -u origin ${branch}`,
        sandbox.workingDirectory,
        60000,
      );
      if (!push.success) {
        return {
          committed: false,
          pushed: false,
          error: push.stdout || push.stderr,
        };
      }

      return {
        committed: false,
        pushed: true,
        commitSha: await getHeadSha(sandbox),
      };
    });
  }

  if (access.authStrategy === "user-token") {
    if (!access.token) {
      return {
        committed: false,
        pushed: false,
        error: "Cannot push: missing GitHub token",
      };
    }
    return pushWithAuth(access.token);
  }

  const writeToken = await mintInstallationToken({
    installationId: access.installationId,
    repositoryIds: [access.repositoryId],
    permissions: { contents: "write" },
  });

  try {
    return pushWithAuth(writeToken.token);
  } catch (error) {
    console.warn(`[auto-commit] Push of existing commits failed for session ${sessionId}:`, error);
    return {
      committed: false,
      pushed: false,
      error: "Failed to push existing commits",
    };
  } finally {
    await revokeInstallationToken(writeToken.token);
  }
}

async function generateCommitMessage(sandbox: Sandbox, sessionTitle: string): Promise<string> {
  const fallback = "chore: update repository changes";

  try {
    const diffForCommit = await getStagedDiff(sandbox);

    if (!diffForCommit.trim()) {
      return fallback;
    }

    const result = await generateText({
      ...commitMessageModel,
      prompt: `Generate a concise git commit message for these changes. Use conventional commit format (e.g., "feat:", "fix:", "refactor:"). One line only, max 72 characters.

Session context: ${sessionTitle}

Diff:
${diffForCommit.slice(0, 8000)}

Respond with ONLY the commit message, nothing else.`,
    });

    const generated = result.text.trim().split("\n")[0]?.trim();
    if (generated && generated.length > 0) {
      return generated.slice(0, 72);
    }
  } catch (error) {
    console.warn("[auto-commit] Failed to generate commit message:", error);
  }

  return fallback;
}
