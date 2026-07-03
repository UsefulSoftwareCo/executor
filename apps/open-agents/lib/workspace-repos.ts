export type WorkspaceRepo = {
  owner: string;
  repo: string;
  branch: string;
  directory: string;
  cloneUrl: string;
};

const DEFAULT_HOOK_WORKSPACE_REPOS: WorkspaceRepo[] = [
  {
    owner: "GoAugment",
    repo: "augment-web",
    branch: "staging",
    directory: "augment-web",
    cloneUrl: "https://github.com/GoAugment/augment-web",
  },
  {
    owner: "GoAugment",
    repo: "augment-services",
    branch: "main",
    directory: "augment-services",
    cloneUrl: "https://github.com/GoAugment/augment-services",
  },
  {
    owner: "GoAugment",
    repo: "augment-voice",
    branch: "main",
    directory: "augment-voice",
    cloneUrl: "https://github.com/GoAugment/augment-voice",
  },
];

const HOOK_WORKSPACE_REPOS_ENV = "OPEN_AGENTS_HOOK_WORKSPACE_REPOS";

const REPO_COORDINATE_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const DIRECTORY_PATTERN = /^[A-Za-z0-9._/-]+$/;

function isSafeWorkspaceDirectory(directory: string): boolean {
  return (
    DIRECTORY_PATTERN.test(directory) &&
    !directory.startsWith("/") &&
    !directory.split("/").includes("..")
  );
}

function parseWorkspaceRepoEntry(entry: string): WorkspaceRepo | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }

  const [repoAndBranch, directoryRaw] = trimmed.split(":", 2);
  if (!repoAndBranch) {
    return null;
  }

  const [repoCoordinate, branchRaw] = repoAndBranch.split("#", 2);
  if (!repoCoordinate || !REPO_COORDINATE_PATTERN.test(repoCoordinate)) {
    return null;
  }

  const [owner, repo] = repoCoordinate.split("/");
  if (!owner || !repo) {
    return null;
  }

  const branch = branchRaw?.trim() || "main";
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) {
    return null;
  }

  const directory = directoryRaw?.trim() || repo;
  if (!isSafeWorkspaceDirectory(directory)) {
    return null;
  }

  return {
    owner,
    repo,
    branch,
    directory,
    cloneUrl: `https://github.com/${owner}/${repo}`,
  };
}

export function parseWorkspaceReposConfig(value: string | undefined): {
  repos: WorkspaceRepo[];
  invalidEntries: string[];
} {
  const invalidEntries: string[] = [];
  const repos =
    value
      ?.split(",")
      .map((entry) => {
        const parsed = parseWorkspaceRepoEntry(entry);
        if (!parsed && entry.trim().length > 0) {
          invalidEntries.push(entry.trim());
        }
        return parsed;
      })
      .filter((repo): repo is WorkspaceRepo => repo !== null) ?? [];

  return { repos, invalidEntries };
}

export function getDefaultHookWorkspaceRepos(): WorkspaceRepo[] {
  const parsed = parseWorkspaceReposConfig(
    process.env[HOOK_WORKSPACE_REPOS_ENV],
  );

  if (parsed.invalidEntries.length > 0) {
    console.warn(
      `Ignoring invalid ${HOOK_WORKSPACE_REPOS_ENV} entries: ${parsed.invalidEntries.join(", ")}`,
    );
  }

  return parsed.repos.length > 0
    ? parsed.repos
    : DEFAULT_HOOK_WORKSPACE_REPOS.map((repo) => ({ ...repo }));
}

export function hasWorkspaceRepos(
  workspaceRepos: WorkspaceRepo[] | null | undefined,
): workspaceRepos is WorkspaceRepo[] {
  return Array.isArray(workspaceRepos) && workspaceRepos.length > 0;
}
