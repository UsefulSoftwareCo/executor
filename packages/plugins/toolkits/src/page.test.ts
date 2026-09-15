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

  it("hides personal tools in org toolkits regardless of display settings", () => {
    expect(toolCanAppearInToolkit(sampleOrgToolkit, userTool)).toBe(false);
    expect(toolCanAppearInToolkit(sampleOrgToolkit, orgTool)).toBe(true);
    expect(toolCanAppearInToolkit(sampleUserToolkit, userTool)).toBe(true);
    expect(toolCanAppearInToolkit(sampleUserToolkit, orgTool)).toBe(true);
  });
});
