/** Exercise the complete local server with the official MCP client and public SDK HTTP routes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Evidence } from "../support/evidence.ts";

const App = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  activeDeployment: Schema.String,
});
const Published = Schema.Struct({ app: App });
const Index = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      app: Schema.Struct({ id: Schema.String, slug: Schema.String }),
    }),
  ),
});
const Document = Schema.Struct({
  content: Schema.String,
  deployment: Schema.String,
  files: Schema.Array(Schema.String),
});
const files = (version: string) => [
  {
    path: "index.ts",
    content:
      'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, async () => ({}));',
  },
  {
    path: "skills/app-authoring/SKILL.md",
    content: `---\nname: app-authoring\ndescription: App-specific instructions.\n---\nVersion ${version}.\n`,
  },
  { path: "skills/app-authoring/references/example.md", content: `Example ${version}.` },
];

layer(TestLive, { excludeTestServices: true })("Local skills", (it) => {
  it.effect(scenarios.localSkills.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const response = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", name: "Skill fixture", files: files("one") },
          headers,
        );
        expect(response.status).toBe(200);
        const { app } = yield* body(Published, response);
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const copyResponse = yield* session.send(
          "POST",
          "/v1/apps/copies",
          { owner: "local", name: "Skill copy", from: app.id },
          headers,
        );
        expect(copyResponse.status).toBe(200);
        const copy = yield* body(App, copyResponse);
        expect(copy.activeDeployment).not.toBe(app.activeDeployment);
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${copy.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(target.apiKey, "local-skills");
        const index = yield* client.use("Discover local app skills", (client, signal) =>
          client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
        );
        const entries = (yield* Schema.decodeUnknownEffect(Index)(index.structuredContent)).skills;
        const guide = entries.find(
          (skill) => skill.name === "app-authoring" && skill.app.slug === "executor",
        );
        if (guide === undefined)
          return yield* Effect.die("The Executor app must publish its authoring skill");
        expect(entries.map((skill) => skill.app.id).sort()).toEqual(
          [app.id, copy.id, guide.app.id].sort(),
        );
        const read = yield* client.use(
          "Read the app-owned app-authoring document",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: app.slug, name: "app-authoring" } },
              undefined,
              { signal },
            ),
        );
        const original = yield* Schema.decodeUnknownEffect(Document)(read.structuredContent);
        expect(original.content).toContain("Version one.");
        const authoring = yield* client.use(
          "Read the Executor app's deployed authoring guide",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: guide.app.slug, name: guide.name } },
              undefined,
              { signal },
            ),
        );
        const guideDocument = yield* Schema.decodeUnknownEffect(Document)(
          authoring.structuredContent,
        );
        expect(guideDocument.content).toContain("# Build an Executor app");
        expect(guideDocument.content).toContain("[ui.md](ui.md)");
        const topic = yield* client.use("Read the routed UI reference on local", (client, signal) =>
          client.callTool(
            {
              name: "skills",
              arguments: {
                app: guide.app.slug,
                name: guide.name,
                deployment: guideDocument.deployment,
                file: "ui.md",
              },
            },
            undefined,
            { signal },
          ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(topic.structuredContent)).content,
        ).toContain("withOptimisticUpdate");
        const profiles = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          yield* session.send("GET", `/v1/apps/${guide.app.id}/profiles`, undefined, headers),
        );
        expect(profiles).toHaveLength(1);
        const profile = profiles[0];
        if (profile === undefined)
          return yield* Effect.die("The local Executor profile is missing");
        const referenceTools = `tools.executor.profiles[${JSON.stringify(profile.id)}]`;
        const contracts = yield* client.use(
          "Discover local framework types through the installed app",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `const found = await ${referenceTools}.queries.framework_search({query: "withOptimisticUpdate"}); return await ${referenceTools}.queries.framework_describe({symbol: "AppMutation.withOptimisticUpdate", ...found.reference});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* (yield* Evidence).json("framework-contracts.json", contracts.structuredContent);
        expect(contracts.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: true },
        });
        const described = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                entry: Schema.Struct({ signatures: Schema.Array(Schema.String) }),
              }),
            }),
          }),
        )(contracts.structuredContent);
        expect(described.execution.value.entry.signatures.join(" ")).toContain(
          "OptimisticUpdate<Input>",
        );

        const source = yield* body(
          Schema.Struct({
            id: Schema.String,
            files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
          }),
          yield* session.send("GET", `/v1/apps/${guide.app.id}/source`, undefined, headers),
        );
        expect(source.id).toBe(guideDocument.deployment);
        expect(source.files.some((file) => file.path.startsWith("skills/"))).toBe(false);
        expect(source.files.find((file) => file.path === "index.ts")?.content).toContain(
          "wellKnownSkills",
        );
        expect(
          (yield* session.send(
            "POST",
            "/v1/apps/deploy",
            {
              owner: "local",
              app: app.id,
              files: files("two"),
            },
            headers,
          )).status,
        ).toBe(200);
        const current = yield* client.use(
          "A redeployment changes the default skill document",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: app.slug, name: "app-authoring" } },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(current.structuredContent)).content,
        ).toContain("Version two.");
        const pinned = yield* client.use(
          "Follow a reference using the original deployment",
          (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: app.slug,
                  name: "app-authoring",
                  file: "references/example.md",
                  deployment: original.deployment,
                },
              },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(pinned.structuredContent)).content,
        ).toBe("Example one.");
        const copyRead = yield* client.use(
          "A configured copy keeps its selected version",
          (client, signal) =>
            client.callTool(
              { name: "skills", arguments: { app: copy.slug, name: "app-authoring" } },
              undefined,
              { signal },
            ),
        );
        const copiedDocument = yield* Schema.decodeUnknownEffect(Document)(
          copyRead.structuredContent,
        );
        expect(copiedDocument.deployment).toBe(copy.activeDeployment);
        expect(copiedDocument.content).toContain("Version one.");
        // Every document needs an app. There is no unscoped authoring-guide fallback.
        for (const input of [
          { file: "SKILL.md" },
          { name: "app-authoring" },
          { name: "app-authoring", deployment: original.deployment },
          { app: app.slug, file: "SKILL.md" },
          { app: app.slug, name: "app-authoring", file: "../index.ts" },
        ]) {
          const invalid = yield* client.use("Reject an invalid skill request", (client, signal) =>
            client.callTool({ name: "skills", arguments: input }, undefined, { signal }),
          );
          expect(invalid.isError).toBe(true);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
