/** Folder defaults and explicit overrides through packaged files and the real runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { skillFolderFixture } from "../support/skill-folder.ts";

layer(HostedLive, { excludeTestServices: true })("Skill folder paths", (it) => {
  it.effect(scenarios.skillFolderPaths.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { read, packaged, helper } = yield* skillFolderFixture;
        yield* Effect.forEach(
          ["../skills", "/skills", "guides/../skills"],
          (path) =>
            Effect.gen(function* () {
              expect(
                (yield* read(
                  `{ skills: await folderSkills({ files: ctx.files, path: ${JSON.stringify(path)} }) }`,
                  packaged,
                  helper,
                )).status,
              ).toBe(502);
            }),
          { concurrency: 3 },
        );
        expect(
          (yield* read(
            "{ skills: [...await folderSkills({ files: ctx.files }), ...await folderSkills({ files: ctx.files })] }",
            packaged,
            helper,
          )).status,
        ).toBe(502);
      }),
    ),
  );
});
