import { describe, expect, it } from "@effect/vitest";
import type { ToolAddress } from "@executor-js/sdk/shared";

import { toolCanAppearInToolkit } from "./page";
import type { ToolkitResponse } from "./shared";

describe("toolCanAppearInToolkit", () => {
  const sampleOrgToolkit: ToolkitResponse = {
    id: "tk_1",
    owner: "org",
    slug: "org-kit",
    name: "Org Kit",
    createdAt: 1,
    updatedAt: 1,
  };

  const sampleUserToolkit: ToolkitResponse = {
    id: "tk_2",
    owner: "user",
    slug: "user-kit",
    name: "User Kit",
    createdAt: 1,
    updatedAt: 1,
  };

  const userTool = {
    address: "tools.github.user.main.repos.list" as ToolAddress,
    integration: "github",
    owner: "user" as const,
    name: "repos.list",
  };

  const orgTool = {
    address: "tools.github.org.main.repos.list" as ToolAddress,
    integration: "github",
    owner: "org" as const,
    name: "repos.list",
  };

  it("allows all tools when showOwnerLabels is false (single-player / desktop host)", () => {
    expect(toolCanAppearInToolkit(sampleOrgToolkit, userTool, false)).toBe(true);
    expect(toolCanAppearInToolkit(sampleOrgToolkit, orgTool, false)).toBe(true);
    expect(toolCanAppearInToolkit(sampleUserToolkit, userTool, false)).toBe(true);
    expect(toolCanAppearInToolkit(sampleUserToolkit, orgTool, false)).toBe(true);
  });

  it("hides personal tools in org toolkits when showOwnerLabels is true (multiplayer / cloud host)", () => {
    expect(toolCanAppearInToolkit(sampleOrgToolkit, userTool, true)).toBe(false);
    expect(toolCanAppearInToolkit(sampleOrgToolkit, orgTool, true)).toBe(true);
    expect(toolCanAppearInToolkit(sampleUserToolkit, userTool, true)).toBe(true);
    expect(toolCanAppearInToolkit(sampleUserToolkit, orgTool, true)).toBe(true);
  });
});
