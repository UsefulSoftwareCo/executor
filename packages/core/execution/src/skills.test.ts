import { describe, expect, it } from "@effect/vitest";

import { EXECUTE_SKILL, SKILLS, findSkill, renderSkillsIndex, skillCatalogFor } from "./skills";

describe("skills registry", () => {
  it("includes the execute skill with the full how-to body", () => {
    expect(SKILLS).toContain(EXECUTE_SKILL);
    // The workflow + rules that the execute description used to inline now live
    // in the skill body.
    expect(EXECUTE_SKILL.body).toContain("## Workflow");
    expect(EXECUTE_SKILL.body).toContain("## Rules");
    expect(EXECUTE_SKILL.body).toContain("Use `emit(value)` to append user-visible output");
    expect(EXECUTE_SKILL.body).toContain(
      "Do not use `fetch` — all API calls go through `tools.*`.",
    );
  });

  it("finds a skill by exact name and misses unknown names", () => {
    expect(findSkill("execute")).toBe(EXECUTE_SKILL);
    expect(findSkill("Execute")).toBeUndefined();
    expect(findSkill("nope")).toBeUndefined();
  });

  it("renders an index that lists every skill with its summary", () => {
    const index = renderSkillsIndex();
    expect(index).toContain('skills({ name: "<name>" })');
    for (const skill of SKILLS) {
      expect(index).toContain(`- \`${skill.name}\` — ${skill.summary}`);
    }
  });

  // A connection that opted out of artifacts has no tool the artifact skills
  // apply to, so they leave its catalog entirely rather than documenting a
  // surface it cannot reach.
  it("drops the artifact skills from a catalog without artifacts", () => {
    const catalog = skillCatalogFor({ artifacts: false });
    expect(catalog).toContain(EXECUTE_SKILL);
    expect(catalog.map((skill) => skill.name)).not.toContain("create-artifact");
    expect(catalog.map((skill) => skill.name)).not.toContain("artifact-style");

    expect(findSkill("create-artifact", catalog)).toBeUndefined();
    expect(renderSkillsIndex(catalog)).not.toContain("`create-artifact`");
  });

  it("serves the full catalog when artifacts are on", () => {
    expect(skillCatalogFor({ artifacts: true })).toEqual(SKILLS);
  });
});
