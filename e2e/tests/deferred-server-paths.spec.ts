/**
 * The API document, the Executor app generator and the authoring skills load on first use.
 * Concurrent reads get one identical document, and the installed Executor app is generated from it.
 * The app reads the published skills at runtime; framework lookups come from the management API.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const Document = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
  components: Schema.Struct({ securitySchemes: Schema.Record(Schema.String, Schema.Json) }),
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const SkillIndex = Schema.fromJsonString(
  Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({ name: Schema.String, files: Schema.Array(Schema.String) }),
    ),
  }),
);
const Configuration = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.Struct({ url: Schema.String }),
    securitySchemes: Schema.Record(Schema.String, Schema.Json),
  }),
);

layer(HostedLive, { excludeTestServices: true })("Deferred server paths", (it) => {
  it.effect(scenarios.deferredServerPaths.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const target = yield* Target;
        const origin = target.metadata.origin;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const anonymous = yield* api.session();
        const installed: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(installed, (id) =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`),
          ).pipe(Effect.orDie),
        );

        // Read the document and install the Executor app together, so neither
        // request relies on the other having produced the document.
        const name = `Executor deferred ${randomUUID().slice(0, 8)}`;
        const [documents, install] = yield* Effect.all(
          [
            Effect.forEach([1, 2, 3], () => api.request(anonymous, "GET", "/openapi.json"), {
              concurrency: "unbounded",
            }),
            api.request(actors.owner, "POST", `${prefix}/apps/install`, {
              entry: `${targetHosts(target).api}/openapi.json`,
              name,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(install.status).toBe(200);
        const app = yield* body(App, install);
        installed.push(app.id);

        for (const response of documents) expect(response.status).toBe(200);
        expect(new Set(documents.map((response) => JSON.stringify(response.body))).size).toBe(1);
        const [first] = documents;
        if (first === undefined) return yield* Effect.die("No API document response");
        const document = yield* body(Document, first);
        expect(Object.keys(document.paths)).toContain("/api/organizations/{organization}/apps");
        expect(Object.keys(document.components.securitySchemes)).toEqual(
          expect.arrayContaining(["browserSession", "oauth"]),
        );

        // The prepared Executor app was generated from the same document.
        const files = (yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
        )).files;
        const configurationFile = files.find((file) => file.path === "openapi.json");
        if (configurationFile === undefined)
          return yield* Effect.die("The prepared Executor app has no OpenAPI configuration");
        const configuration = yield* Schema.decodeUnknownEffect(Configuration)(
          configurationFile.content,
        );
        // The Executor app calls the API at its canonical origin.
        expect(configuration.source.url).toBe(`${targetHosts(target).api}/openapi.json`);
        expect(configuration.securitySchemes).toEqual(document.components.securitySchemes);

        // The app reads its skills from the published index; the server answers framework lookups.
        expect(files.map((file) => file.path)).not.toContain("framework-reference.json");
        const lookup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/framework/search?text=${encodeURIComponent("defineApp")}`,
        );
        expect(lookup.status, JSON.stringify(lookup.body)).toBe(200);
        expect(lookup.body).toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining({ symbol: expect.stringContaining("defineApp") }),
          ]),
        });
        // The app reads its skills beside the API it calls, at the canonical API origin.
        expect(files.find((file) => file.path === "index.ts")?.content).toContain(
          `${targetHosts(target).api}/.well-known/agent-skills/index.json`,
        );
        const http = yield* HttpClient.HttpClient;
        const published = (path: string) =>
          http.get(`${origin}/.well-known/agent-skills/${path}`).pipe(
            Effect.flatMap((response) =>
              Effect.map(response.text, (text) => ({
                status: response.status,
                contentType: response.headers["content-type"],
                text,
              })),
            ),
          );
        const index = yield* published("index.json");
        expect(index.status).toBe(200);
        const { skills } = yield* Schema.decodeUnknownEffect(SkillIndex)(index.text);
        // Every skill directory the host ships is published, with the entry skill beside the guides.
        expect(skills.map((skill) => skill.name).sort()).toEqual([
          "app-authoring",
          "code-mode",
          "executor",
        ]);
        expect(skills.find((skill) => skill.name === "executor")?.files.toSorted()).toEqual([
          "SKILL.md",
          "feedback.md",
        ]);
        expect(skills.find((skill) => skill.name === "app-authoring")?.files).toContain("SKILL.md");
        for (const skill of skills)
          for (const path of skill.files) {
            const file = yield* published(`${skill.name}/${path}`);
            expect(file.status).toBe(200);
            expect(file.contentType).toBe("text/markdown; charset=utf-8");
            expect(file.text.length).toBeGreaterThan(0);
          }
        expect((yield* published("app-authoring/SKILL.md")).text).toMatch(
          /^---\nname: app-authoring\n/,
        );
        expect((yield* published("executor/SKILL.md")).text).toMatch(/^---\nname: executor\n/);
        expect((yield* published("app-authoring/missing.md")).status).toBe(404);
        // Feedback guidance belongs to the entry skill, not the authoring guide.
        expect((yield* published("app-authoring/feedback.md")).status).toBe(404);
      }),
    ),
  );
});
