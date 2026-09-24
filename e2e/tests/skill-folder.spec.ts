/** Folder defaults and explicit overrides through packaged app files and the real runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App } from "../support/contracts.ts";

const Bundle = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
const document = (name: string) =>
  `---\nname: ${name}\ndescription: Packaged instructions.\nmetadata:\n  version: "1"\n---\n# ${name}`;
const packaged = [
  { path: "skills/local-guide/SKILL.md", content: document("local-guide") },
  { path: "skills/local-guide/references/example.md", content: "Packaged reference" },
  { path: "guides/extra-guide/SKILL.md", content: document("extra-guide") },
  { path: "private.txt", content: "Outside the selected skill folder" },
];

layer(HostedLive, { excludeTestServices: true })("Skill folders", (it) => {
  it.effect(scenarios.skillFolder.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const read = (definition: string, files = packaged, imports = "") =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `Skill folders ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp } from "apps";\n${imports}\nexport default defineApp({ accounts: {} }, async (ctx) => (${definition}));`,
                },
                ...files,
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/skill-bundle`);
          });
        const bundle = (definition: string, files = packaged, imports = "") =>
          Effect.gen(function* () {
            const response = yield* read(definition, files, imports);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Bundle, response);
          });
        // This is the regression: the SDK used to append the folder despite the explicit empty catalog.
        expect((yield* bundle("{ skills: [] }")).skills).toEqual([]);
        const defaults = yield* bundle("{}");
        expect(defaults.skills.map((skill) => skill.name)).toEqual(["local-guide"]);
        expect(defaults.skills[0]?.files).toEqual([
          { path: "references/example.md", content: "Packaged reference" },
          { path: "SKILL.md", content: document("local-guide") },
        ]);
        expect((yield* bundle("{}", [])).skills).toEqual([]);
        const helper = 'import { folderSkills, fileSkill } from "apps/skills";';
        expect(
          yield* bundle("{ skills: await folderSkills({ files: ctx.files }) }", packaged, helper),
        ).toEqual(defaults);
        expect(
          (yield* bundle(
            `{ skills: [await fileSkill([{ path: "SKILL.md", content: ${JSON.stringify(document("replacement"))} }])] }`,
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
        for (const path of ["../skills", "/skills", "guides/../skills"]) {
          expect(
            (yield* read(
              `{ skills: await folderSkills({ files: ctx.files, path: ${JSON.stringify(path)} }) }`,
              packaged,
              helper,
            )).status,
          ).toBe(502);
        }
        // Every selected file source uses the same frontmatter and matching-name checks.
        for (const invalid of [
          { path: "skills/local-guide/SKILL.md", content: "No frontmatter" },
          {
            path: "skills/local-guide/SKILL.md",
            content: "---\nname: local-guide\nname: duplicate\ndescription: Example\n---\n",
          },
          { path: "skills/local-guide/SKILL.md", content: document("mismatch") },
          { path: "skills/local-guide/reference.md", content: "Missing SKILL.md" },
          { path: "skills/Bad-Name/SKILL.md", content: document("local-guide") },
          { path: "skills/invalid?#/SKILL.md", content: document("local-guide") },
        ]) {
          expect((yield* bundle("{ skills: [] }", [invalid])).skills).toEqual([]);
          expect((yield* read("{}", [invalid])).status).toBe(502);
          expect(
            (yield* read("{ skills: await folderSkills({ files: ctx.files }) }", [invalid], helper))
              .status,
          ).toBe(502);
        }
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
