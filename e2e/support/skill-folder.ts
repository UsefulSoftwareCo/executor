/** Packaged skill fixtures deployed through the public hosted API. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { App } from "./contracts.ts";

const Bundle = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
/** Complete synthetic skill document with a matching name. */
export const skillDocument = (name: string) =>
  `---\nname: ${name}\ndescription: Packaged instructions.\nmetadata:\n  version: "1"\n---\n# ${name}`;
const packaged = [
  { path: "skills/local-guide/SKILL.md", content: skillDocument("local-guide") },
  { path: "skills/local-guide/references/example.md", content: "Packaged reference" },
  { path: "guides/extra-guide/SKILL.md", content: skillDocument("extra-guide") },
  { path: "private.txt", content: "Outside the selected skill folder" },
];

/** Each read owns its deployed app until the case scope closes. */
export const skillFolderFixture = Effect.gen(function* () {
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
  return {
    read,
    bundle,
    packaged,
    helper: 'import { folderSkills, fileSkill } from "apps/skills";',
  };
});
