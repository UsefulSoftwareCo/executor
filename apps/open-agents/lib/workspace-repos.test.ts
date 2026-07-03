import { afterEach, describe, expect, test } from "bun:test";
import {
  getDefaultHookWorkspaceRepos,
  parseWorkspaceReposConfig,
} from "./workspace-repos";

const originalHookWorkspaceReposEnv =
  process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS;

afterEach(() => {
  if (originalHookWorkspaceReposEnv === undefined) {
    delete process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS;
  } else {
    process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS =
      originalHookWorkspaceReposEnv;
  }
});

describe("parseWorkspaceReposConfig", () => {
  test("parses owner repo branch and directory entries", () => {
    const result = parseWorkspaceReposConfig(
      "GoAugment/augment-web#staging:augment-web,GoAugment/augment-voice#main",
    );

    expect(result.invalidEntries).toEqual([]);
    expect(result.repos).toEqual([
      {
        owner: "GoAugment",
        repo: "augment-web",
        branch: "staging",
        directory: "augment-web",
        cloneUrl: "https://github.com/GoAugment/augment-web",
      },
      {
        owner: "GoAugment",
        repo: "augment-voice",
        branch: "main",
        directory: "augment-voice",
        cloneUrl: "https://github.com/GoAugment/augment-voice",
      },
    ]);
  });

  test("rejects unsafe directories", () => {
    const result = parseWorkspaceReposConfig(
      "GoAugment/augment-web#staging:../augment-web,GoAugment/augment-voice#main:/tmp/voice",
    );

    expect(result.repos).toEqual([]);
    expect(result.invalidEntries).toEqual([
      "GoAugment/augment-web#staging:../augment-web",
      "GoAugment/augment-voice#main:/tmp/voice",
    ]);
  });
});

describe("getDefaultHookWorkspaceRepos", () => {
  test("returns the Augment triage defaults", () => {
    delete process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS;

    expect(getDefaultHookWorkspaceRepos()).toEqual([
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
    ]);
  });

  test("uses the hook workspace config", () => {
    process.env.OPEN_AGENTS_HOOK_WORKSPACE_REPOS =
      "GoAugment/augment-web#staging:augment-web";

    expect(getDefaultHookWorkspaceRepos()).toEqual([
      {
        owner: "GoAugment",
        repo: "augment-web",
        branch: "staging",
        directory: "augment-web",
        cloneUrl: "https://github.com/GoAugment/augment-web",
      },
    ]);
  });
});
