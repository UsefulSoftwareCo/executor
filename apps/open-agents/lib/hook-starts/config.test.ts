import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceRepo } from "@/lib/workspace-repos";
import {
  getHookStartWorkspaceRepos,
  getHookWorkflowOptions,
  HOOK_DEFAULT_MAX_STEPS,
  HOOK_WORKSPACE_MAX_STEPS,
  parseHookRepoTarget,
} from "./config";

const originalHookWorkspaceReposEnv =
  process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS;

const workspaceRepos: WorkspaceRepo[] = [
  {
    owner: "GoAugment",
    repo: "augment-web",
    branch: "staging",
    directory: "augment-web",
    cloneUrl: "https://github.com/GoAugment/augment-web",
  },
];

afterEach(() => {
  if (originalHookWorkspaceReposEnv === undefined) {
    delete process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS;
  } else {
    process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS =
      originalHookWorkspaceReposEnv;
  }
});

describe("parseHookRepoTarget", () => {
  test("parses GitHub URLs and repo annotations", () => {
    expect(
      parseHookRepoTarget("https://github.com/GoAugment/augment-web/issues/1"),
    ).toEqual({ owner: "GoAugment", repo: "augment-web" });
    expect(parseHookRepoTarget("repo: GoAugment/augment-voice")).toEqual({
      owner: "GoAugment",
      repo: "augment-voice",
    });
  });

  test("parses bare owner repo coordinates", () => {
    expect(parseHookRepoTarget("GoAugment/augment-services")).toEqual({
      owner: "GoAugment",
      repo: "augment-services",
    });
  });
});

describe("getHookStartWorkspaceRepos", () => {
  test("uses default workspace repos when no repo target was found", () => {
    process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS =
      "GoAugment/augment-web#staging:augment-web";

    expect(getHookStartWorkspaceRepos(null)).toEqual(workspaceRepos);
  });

  test("does not add workspace repos when a single repo target was found", () => {
    process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS =
      "GoAugment/augment-web#staging:augment-web";

    expect(
      getHookStartWorkspaceRepos({
        owner: "GoAugment",
        repo: "augment-web",
      }),
    ).toEqual([]);
  });
});

describe("getHookWorkflowOptions", () => {
  test("keeps single-repo starts on the default workflow budget with commit automation", () => {
    expect(
      getHookWorkflowOptions({
        repoOwner: "GoAugment",
        repoName: "augment-web",
        workspaceRepos: [],
      }),
    ).toEqual({
      maxSteps: HOOK_DEFAULT_MAX_STEPS,
      autoCommitEnabled: true,
      autoCreatePrEnabled: true,
      hasRepo: true,
      hasWorkspaceRepos: false,
    });
  });

  test("uses the bounded investigation budget for workspace starts", () => {
    expect(
      getHookWorkflowOptions({
        repoOwner: null,
        repoName: null,
        workspaceRepos,
      }),
    ).toEqual({
      maxSteps: HOOK_WORKSPACE_MAX_STEPS,
      autoCommitEnabled: false,
      autoCreatePrEnabled: false,
      hasRepo: false,
      hasWorkspaceRepos: true,
    });
  });
});
