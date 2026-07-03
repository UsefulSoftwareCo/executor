import {
  getDefaultHookWorkspaceRepos,
  hasWorkspaceRepos,
  type WorkspaceRepo,
} from "@/lib/workspace-repos";

export const HOOK_DEFAULT_MAX_STEPS = 500;
export const HOOK_WORKSPACE_MAX_STEPS = 80;
export const HOOK_WORKSPACE_STARTED_LABEL = "Augment triage workspace";

export type RepoTarget = {
  owner: string;
  repo: string;
};

export type HookWorkflowSession = {
  repoOwner?: string | null;
  repoName?: string | null;
  workspaceRepos?: WorkspaceRepo[] | null;
};

export type HookWorkflowOptions = {
  maxSteps: number;
  autoCommitEnabled: boolean;
  autoCreatePrEnabled: boolean;
  hasRepo: boolean;
  hasWorkspaceRepos: boolean;
};

export function parseHookRepoTarget(text: string): RepoTarget | null {
  const githubUrlMatch = text.match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i,
  );
  if (githubUrlMatch?.[1] && githubUrlMatch[2]) {
    return { owner: githubUrlMatch[1], repo: githubUrlMatch[2] };
  }

  const explicitRepoMatch = text.match(
    /\brepo(?:sitory)?\s*[:=]?\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/i,
  );
  if (explicitRepoMatch?.[1] && explicitRepoMatch[2]) {
    return { owner: explicitRepoMatch[1], repo: explicitRepoMatch[2] };
  }

  const ownerRepoMatch = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (ownerRepoMatch?.[1] && ownerRepoMatch[2]) {
    return { owner: ownerRepoMatch[1], repo: ownerRepoMatch[2] };
  }

  return null;
}

export function getHookStartWorkspaceRepos(
  repoTarget: RepoTarget | null,
): WorkspaceRepo[] {
  return repoTarget ? [] : getDefaultHookWorkspaceRepos();
}

export function getHookWorkflowOptions(
  session: HookWorkflowSession,
): HookWorkflowOptions {
  const hasRepo = session.repoOwner != null && session.repoName != null;
  const hasHookWorkspaceRepos = hasWorkspaceRepos(session.workspaceRepos);

  return {
    maxSteps: hasHookWorkspaceRepos
      ? HOOK_WORKSPACE_MAX_STEPS
      : HOOK_DEFAULT_MAX_STEPS,
    autoCommitEnabled: hasRepo,
    autoCreatePrEnabled: hasRepo,
    hasRepo,
    hasWorkspaceRepos: hasHookWorkspaceRepos,
  };
}

export function formatHookWorkspaceReposForPrompt(
  workspaceRepos: WorkspaceRepo[] | null | undefined,
): string | undefined {
  if (!hasWorkspaceRepos(workspaceRepos)) {
    return undefined;
  }

  return workspaceRepos
    .map(
      (repo) => `${repo.directory}: ${repo.owner}/${repo.repo}#${repo.branch}`,
    )
    .join("\n");
}

export function formatHookWorkspaceReposForEnvironment(
  workspaceRepos: WorkspaceRepo[] | null | undefined,
): string | undefined {
  if (!hasWorkspaceRepos(workspaceRepos)) {
    return undefined;
  }

  return workspaceRepos
    .map(
      (repo) =>
        `  - ${repo.directory}: ${repo.owner}/${repo.repo} (${repo.branch})`,
    )
    .join("\n");
}

export function appendHookWorkspaceEnvironmentDetails(params: {
  environmentDetails?: string;
  workspaceRepos: WorkspaceRepo[] | null | undefined;
}): string | undefined {
  const workspaceRepoText = formatHookWorkspaceReposForEnvironment(
    params.workspaceRepos,
  );
  if (!workspaceRepoText) {
    return params.environmentDetails;
  }

  return `${params.environmentDetails ?? ""}\n- Multi-repo workspace directories:\n${workspaceRepoText}\n- Use the augment-voi-triage skill for Augment VOI investigations.`.trim();
}

export function getHookWorkspaceStartedText(
  workspaceRepos: WorkspaceRepo[] | null | undefined,
): string {
  return hasWorkspaceRepos(workspaceRepos)
    ? ` in the ${HOOK_WORKSPACE_STARTED_LABEL}`
    : "";
}
