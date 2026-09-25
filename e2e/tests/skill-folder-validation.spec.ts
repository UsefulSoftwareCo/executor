/** Folder defaults and explicit overrides through packaged files and the real runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { skillFolderFixture, skillDocument } from "../support/skill-folder.ts";

layer(HostedLive, { excludeTestServices: true })("Skill folder validation", (it) => {
  it.effect(scenarios.skillFolderValidation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { read, bundle, helper } = yield* skillFolderFixture;
        // Every selected file source uses the same frontmatter and matching-name checks.
        yield* Effect.forEach(
          [
            { path: "skills/local-guide/SKILL.md", content: "No frontmatter" },
            {
              path: "skills/local-guide/SKILL.md",
              content: "---\nname: local-guide\nname: duplicate\ndescription: Example\n---\n",
            },
            { path: "skills/local-guide/SKILL.md", content: skillDocument("mismatch") },
            { path: "skills/local-guide/reference.md", content: "Missing SKILL.md" },
            { path: "skills/Bad-Name/SKILL.md", content: skillDocument("local-guide") },
            { path: "skills/invalid?#/SKILL.md", content: skillDocument("local-guide") },
          ],
          (invalid) =>
            Effect.gen(function* () {
              expect((yield* bundle("{ skills: [] }", [invalid])).skills).toEqual([]);
              expect((yield* read("{}", [invalid])).status).toBe(502);
              expect(
                (yield* read(
                  "{ skills: await folderSkills({ files: ctx.files }) }",
                  [invalid],
                  helper,
                )).status,
              ).toBe(502);
            }),
          { concurrency: 3 },
        );
      }),
    ),
  );
});
