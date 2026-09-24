import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { parseGitHubSkillInput } from "./skill-source-input";

describe("parseGitHubSkillInput", () => {
  it("accepts the install forms used by GitHub and skills.sh", () => {
    expect(Option.getOrNull(parseGitHubSkillInput("owner/repo/skills/pdf"))).toEqual({
      owner: "owner",
      repository: "repo",
      requestedRef: null,
      directory: "skills/pdf",
      selectedSkills: [],
    });
    expect(
      Option.getOrNull(
        parseGitHubSkillInput("npx skills add https://skills.sh/owner/repo --skill pdf,csv"),
      ),
    ).toMatchObject({ owner: "owner", repository: "repo", selectedSkills: ["pdf", "csv"] });
    expect(
      Option.getOrNull(
        parseGitHubSkillInput("https://github.com/owner/repo/blob/v1/skills/pdf/SKILL.md"),
      ),
    ).toMatchObject({ requestedRef: "v1", directory: "skills/pdf" });
  });

  it("rejects unsupported hosts and parent traversal", () => {
    expect(Option.isNone(parseGitHubSkillInput("https://example.com/owner/repo"))).toBe(true);
    expect(Option.isNone(parseGitHubSkillInput("owner/repo/../secret"))).toBe(true);
  });
});
