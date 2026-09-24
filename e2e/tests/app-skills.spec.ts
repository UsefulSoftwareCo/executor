import { saveAndDeploy } from "../support/app-authoring.ts";
/** Bundled skills are tested through the real hosted API, with no app implementation imports. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });
const Catalog = Schema.Struct({
  app: App,
  deployment: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});
const Bundle = Schema.Struct({
  deployment: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
const Document = Schema.Struct({
  app: App,
  deployment: Schema.String,
  content: Schema.String,
  files: Schema.Array(Schema.String),
});
const source = `import { defineApp } from "apps";
export default defineApp({ accounts: {} }, async () => ({}));`;
const document = (version: string) =>
  `---\nname: search-messages\ndescription: Search cached messages.\nallowed-tools: queries.search\nmetadata:\n  version: "${version}"\n---\nRead [examples](references/examples.md).\n`;
const files = (version: string) => [
  { path: "index.ts", content: source },
  { path: "private.txt", content: "Outside the skill directory" },
  { path: "skills/search-messages/SKILL.md", content: document(version) },
  { path: "skills/search-messages/references/examples.md", content: `Examples ${version}\r\n` },
  { path: "skills/search-messages/scripts/example.ts", content: "throw new Error('Never run');" },
  {
    path: "skills/other/SKILL.md",
    content: "---\nname: other\ndescription: Another skill\n---\nOther.",
  },
];

layer(HostedLive, { excludeTestServices: true })("App skills", (it) => {
  it.effect(scenarios.appSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name,
              files: files("v1"),
            });
            expect(response.status).toBe(200);
            const app = yield* body(Deployed, response);
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/${app.id}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);

            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const app = yield* deploy(`Skill fixture ${randomUUID().slice(0, 8)}`);
        const other = yield* deploy(`Other fixture ${randomUUID().slice(0, 8)}`);
        const path = `${prefix}/${app.id}`;
        const read = `${path}/skills/search-messages`;
        expect((yield* api.request(actors.member, "GET", `${path}/tools`)).status).toBe(200);
        const catalogResponse = yield* api.request(actors.member, "GET", `${path}/skills`);
        expect(catalogResponse.status).toBe(200);
        const catalog = yield* body(Catalog, catalogResponse);
        expect(catalog.app.id).toBe(app.id);
        expect(catalog.skills.map((skill) => skill.name)).toEqual(["other", "search-messages"]);
        expect(JSON.stringify(catalogResponse.body)).not.toContain("Never run");
        const bundleResponse = yield* api.request(actors.member, "GET", `${path}/skill-bundle`);
        expect(bundleResponse.status).toBe(200);
        const bundle = yield* body(Bundle, bundleResponse);
        expect(bundle.deployment).toBe(app.activeDeployment);
        expect(bundle.skills.map((skill) => skill.name)).toEqual(["other", "search-messages"]);
        expect(
          bundle.skills.flatMap((skill) => skill.files.map((file) => file.path)),
        ).not.toContain("private.txt");
        expect(
          bundle.skills
            .find((skill) => skill.name === "search-messages")
            ?.files.find((file) => file.path === "SKILL.md")?.content,
        ).toBe(document("v1"));
        const doc = yield* body(Document, yield* api.request(actors.member, "GET", read));
        expect(doc.content).toBe(document("v1"));
        expect(doc.files).toContain("references/examples.md");
        expect(doc.files).not.toContain("private.txt");
        const script = yield* body(
          Document,
          yield* api.request(actors.member, "GET", `${read}?file=scripts%2Fexample.ts`),
        );
        expect(script.content).toBe("throw new Error('Never run');");
        for (const file of [
          "../private.txt",
          "/index.ts",
          "references/../../other/SKILL.md",
          "references\\examples.md",
        ]) {
          expect(
            (yield* api.request(actors.member, "GET", `${read}?file=${encodeURIComponent(file)}`))
              .status,
          ).toBe(400);
        }
        for (const file of ["private.txt", "index.ts", "skills/other/SKILL.md"]) {
          expect(
            (yield* api.request(actors.member, "GET", `${read}?file=${encodeURIComponent(file)}`))
              .status,
          ).toBe(404);
        }
        expect(
          (yield* api.request(actors.member, "GET", `${read}?deployment=${other.activeDeployment}`))
            .status,
        ).toBe(404);
        expect((yield* api.request(actors.member, "GET", `${path}/source`)).status).toBe(403);
        const anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", read)).status).toBe(401);
        expect((yield* api.request(anonymous, "GET", `${path}/skill-bundle`)).status).toBe(401);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `/api/organizations/unrelated-organization/apps/${app.id}/skills`,
          )).status,
        ).toBe(403);

        const changed = yield* saveAndDeploy(actors.owner, path, {
          files: files("v2"),
        });
        expect(changed.status).toBe(200);
        const { app: updated } = yield* body(Schema.Struct({ app: Deployed }), changed);
        expect(
          (yield* body(Document, yield* api.request(actors.member, "GET", read))).content,
        ).toBe(document("v2"));
        const reference = yield* body(
          Document,
          yield* api.request(
            actors.member,
            "GET",
            `${read}?deployment=${doc.deployment}&file=references%2Fexamples.md`,
          ),
        );
        expect(reference.content).toBe("Examples v1\r\n");
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/activate`, {
            deployment: app.activeDeployment,
            expectedDeployment: updated.activeDeployment,
          })).status,
        ).toBe(200);
        expect(
          (yield* body(Document, yield* api.request(actors.member, "GET", read))).content,
        ).toBe(document("v1"));
        expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
        // Deletion also removes the member's resource grant, so policy denies the read first.
        expect((yield* api.request(actors.member, "GET", read)).status).toBe(403);
        expect((yield* api.request(actors.member, "GET", `${path}/skill-bundle`)).status).toBe(403);
      }),
    ),
  );
});
