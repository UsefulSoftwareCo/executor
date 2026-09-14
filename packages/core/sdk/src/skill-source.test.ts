import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { formatGitHubSkillSource, parseGitHubSkillSource } from "./skill-source";

const parse = (input: string) => Option.getOrNull(parseGitHubSkillSource(input));

describe("parseGitHubSkillSource", () => {
  it.each([
    [
      "npx skills add https://github.com/kitlangton/skills --skill effect",
      { owner: "kitlangton", repo: "skills", ref: null, path: "", skills: ["effect"] },
    ],
    [
      "bunx skills add owner/repo -s a,b --skill=c",
      { owner: "owner", repo: "repo", ref: null, path: "", skills: ["a", "b", "c"] },
    ],
    [
      "gh skill install owner/repo/skills/pdf",
      { owner: "owner", repo: "repo", ref: null, path: "skills/pdf", skills: [] },
    ],
    ["owner/repo", { owner: "owner", repo: "repo", ref: null, path: "" }],
    ["owner/repo/skills/pdf", { owner: "owner", repo: "repo", ref: null, path: "skills/pdf" }],
    ["github.com/owner/repo", { owner: "owner", repo: "repo", ref: null, path: "" }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo", ref: null, path: "" }],
    [
      "https://github.com/owner/repo/tree/main/skills/pdf",
      { owner: "owner", repo: "repo", ref: "main", path: "skills/pdf" },
    ],
    [
      "https://github.com/owner/repo/blob/v1.2/skills/pdf/SKILL.md",
      { owner: "owner", repo: "repo", ref: "v1.2", path: "skills/pdf" },
    ],
    ["https://skills.sh/owner/repo/pdf", { owner: "owner", repo: "repo", ref: null, path: "pdf" }],
    ["https://www.github.com/owner/repo/", { owner: "owner", repo: "repo", ref: null, path: "" }],
  ])("parses %s", (input, expected) => {
    expect(parse(input)).toEqual({ skills: [], ...expected });
  });

  it.each([
    "",
    "owner",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "owner/repo/../etc",
    "not a url at all",
  ])("rejects %s", (input) => {
    expect(parse(input)).toBeNull();
  });

  it("formats a source as owner/repo@ref/path", () => {
    expect(
      formatGitHubSkillSource({ owner: "o", repo: "r", ref: "main", path: "skills/x", skills: [] }),
    ).toBe("o/r@main/skills/x");
    expect(
      formatGitHubSkillSource({ owner: "o", repo: "r", ref: null, path: "", skills: [] }),
    ).toBe("o/r");
  });
});
