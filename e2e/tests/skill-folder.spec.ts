/** Folder defaults and explicit overrides through packaged files and the real runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { skillFolderFixture, skillDocument } from "../support/skill-folder.ts";

layer(HostedLive, { excludeTestServices: true })("Skill folders", (it) => {
  it.effect(scenarios.skillFolder.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { bundle, packaged, helper } = yield* skillFolderFixture;
        // This is the regression: the SDK used to append the folder despite the explicit empty catalog.
        expect((yield* bundle("{ skills: [] }")).skills).toEqual([]);
        const defaults = yield* bundle("{}");
        expect(defaults.skills.map((skill) => skill.name)).toEqual(["local-guide"]);
        expect(defaults.skills[0]?.files).toEqual([
          { path: "references/example.md", content: "Packaged reference" },
          { path: "SKILL.md", content: skillDocument("local-guide") },
        ]);
        expect((yield* bundle("{}", [])).skills).toEqual([]);
        expect(
          yield* bundle("{ skills: await folderSkills({ files: ctx.files }) }", packaged, helper),
        ).toEqual(defaults);
        expect(
          (yield* bundle(
            `{ skills: [await fileSkill([{ path: "SKILL.md", content: ${JSON.stringify(skillDocument("replacement"))} }])] }`,
            packaged,
            helper,
          )).skills.map((skill) => skill.name),
        ).toEqual(["replacement"]);
        expect(
          (yield* bundle(
            '{ skills: [...await folderSkills({ files: ctx.files }), ...await folderSkills({ files: ctx.files, path: "guides" })] }',
            packaged,
            helper,
          )).skills.map((skill) => skill.name),
        ).toEqual(["extra-guide", "local-guide"]);
        expect(
          (yield* bundle(
            '{ skills: await folderSkills({ files: ctx.files, path: "absent" }) }',
            packaged,
            helper,
          )).skills,
        ).toEqual([]);
      }),
    ),
  );
});
