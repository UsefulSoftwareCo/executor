/** Exercise the complete local server with the official MCP client and public SDK HTTP routes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { wholeStringInputPattern } from "../support/mcp-input-patterns.ts";

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
      deployment: Schema.String,
      profile: Schema.optional(Schema.String),
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
  appsManifest,
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
        const instructions = yield* client.use("Read the server's MCP instructions", (client) =>
          Promise.resolve(client.getInstructions()),
        );
        const index = yield* client.use("Discover local app skills", (client, signal) =>
          client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
        );
        const entries = (yield* Schema.decodeUnknownEffect(Index)(index.structuredContent)).skills;
        const guide = entries.find(
          (skill) => skill.name === "executor" && skill.app.slug === "executor",
        );
        if (guide === undefined)
          return yield* Effect.die("The Executor app must publish its entry skill");
        expect(entries.map((skill) => `${skill.app.id}/${skill.name}`).sort()).toEqual(
          [
            `${app.id}/app-authoring`,
            `${copy.id}/app-authoring`,
            `${guide.app.id}/app-authoring`,
            `${guide.app.id}/code-mode`,
            `${guide.app.id}/executor`,
          ].sort(),
        );
        const entry = yield* client.use("Read the Executor app's entry skill", (client, signal) =>
          client.callTool(
            { name: "skills", arguments: { app: guide.app.slug, name: guide.name } },
            undefined,
            { signal },
          ),
        );
        const entryDocument = yield* Schema.decodeUnknownEffect(Document)(entry.structuredContent);
        expect(entryDocument.files).toContain("feedback.md");
        // Local sends the same entry skill as its MCP instructions, without the frontmatter.
        expect(instructions).toBe(
          entryDocument.content.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
        );
        if (guide.profile === undefined)
          return yield* Effect.die("The Executor app's skill summary must name its profile");
        const listed = yield* client.use("Discover the skills input schema", (client) =>
          client.listTools(),
        );
        expect(guide.deployment).toMatch(
          yield* wholeStringInputPattern(listed.tools, "skills", "deployment"),
        );
        expect(guide.profile).toMatch(
          yield* wholeStringInputPattern(listed.tools, "skills", "profile"),
        );
        const selected = yield* client.use(
          "Read the guide with its returned deployment and profile",
          (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: guide.app.slug,
                  name: guide.name,
                  deployment: guide.deployment,
                  profile: guide.profile,
                },
              },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(selected.structuredContent)).deployment,
        ).toBe(guide.deployment);
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
              { name: "skills", arguments: { app: guide.app.slug, name: "app-authoring" } },
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
                name: "app-authoring",
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
        const profileTools = yield* client.use(
          "Discover profile management operations",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: 'return await tools.search({ query: "appProfiles.create" });' },
              },
              undefined,
              { signal },
            ),
        );
        yield* (yield* Evidence).json("profile-tools.json", profileTools.structuredContent);
        expect(profileTools.structuredContent).toMatchObject({
          status: "completed",
          execution: {
            ok: true,
            value: {
              items: expect.arrayContaining([
                expect.objectContaining({
                  path: expect.stringContaining("appProfiles.create"),
                  input: expect.stringContaining("idempotencyKey"),
                }),
              ]),
            },
          },
        });
        const managedProfile = yield* client.use(
          "Create, read, and update a profile through the management app",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `const executor = ${referenceTools};
const path = { app: ${JSON.stringify(app.id)} };
const created = await executor.appProfiles.create({ path, body: { owner: "local", subject: "local", accounts: {}, idempotencyKey: "management-docs-profile" } });
const target = { ...path, profile: created.id };
const read = await executor.appProfiles.get({ path: target });
const updated = await executor.appProfiles.update({ path: target, body: { expectedRevision: read.revision, accounts: {} } });
const listed = await executor.appProfiles.list({ path });
return { sameProfile: created.id === read.id && read.id === updated.id, listed: listed.some((profile) => profile.id === created.id), revision: updated.revision, previousRevision: read.revision };`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const managed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                sameProfile: Schema.Boolean,
                listed: Schema.Boolean,
                revision: Schema.Number,
                previousRevision: Schema.Number,
              }),
            }),
          }),
        )(managedProfile.structuredContent);
        expect(managed.execution.value.sameProfile).toBe(true);
        expect(managed.execution.value.listed).toBe(true);
        expect(managed.execution.value.revision).toBeGreaterThan(
          managed.execution.value.previousRevision,
        );

        const contracts = yield* client.use(
          "Discover local framework types through the installed app",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `const found = await ${referenceTools}.framework.search({query: {text: "withOptimisticUpdate"}}); return await ${referenceTools}.framework.describe({query: {symbol: "AppMutation.withOptimisticUpdate", ...found.reference}});`,
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
