/** Exercise the complete local server with the official MCP client and public SDK HTTP routes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectAccountsThroughOtherApp } from "../support/app-accounts.ts";
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
      revision: Schema.String,
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
    content: 'import { defineApp } from "apps"; export default defineApp({}, async () => ({}));',
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
        const listed = yield* client.use("Discover the skills input schema", (client) =>
          client.listTools(),
        );
        expect(guide.deployment).toMatch(
          yield* wholeStringInputPattern(listed.tools, "skills", "deployment"),
        );
        expect(guide.revision).toMatch(
          yield* wholeStringInputPattern(listed.tools, "skills", "revision"),
        );
        const selected = yield* client.use(
          "Read the guide with its returned deployment and revision",
          (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: guide.app.slug,
                  name: guide.name,
                  deployment: guide.deployment,
                  revision: guide.revision,
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
        // The Executor app appears once, at its slug, with its linked local key.
        const referenceTools = "tools.executor";
        const accountTools = yield* client.use(
          "Discover account management operations",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: 'return await tools.search({ query: "accounts.update" });' },
              },
              undefined,
              { signal },
            ),
        );
        yield* (yield* Evidence).json("account-tools.json", accountTools.structuredContent);
        expect(accountTools.structuredContent).toMatchObject({
          status: "completed",
          execution: {
            ok: true,
            value: {
              items: expect.arrayContaining([
                expect.objectContaining({
                  path: expect.stringContaining("accounts.update"),
                  input: expect.stringContaining("description"),
                }),
              ]),
            },
          },
        });
        // Agents save accounts only by completing an app's connection request, so the fixture
        // connects one and the management app reads, renames, lists, and removes it.
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const [docsAccount] = yield* connectAccountsThroughOtherApp(agent, {
          provider: `defineProvider({ name: "Local skills docs", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`,
          method: "key",
          accounts: [{ label: "Docs account", fields: { token: "synthetic-docs-key" } }],
        });
        if (docsAccount === undefined)
          return yield* Effect.die("The docs fixture account was not connected");
        const managedAccount = yield* client.use(
          "Read, update, list, and remove an account through the management app",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `const executor = ${referenceTools};
const owner = "local";
const target = { account: ${JSON.stringify(docsAccount.id)} };
const read = await executor.accounts.get({ path: target, query: { owner } });
const updated = await executor.accounts.update({ path: target, query: { owner }, body: { label: "Renamed docs account" } });
const listed = await executor.accounts.list({ query: { owner } });
await executor.accounts.remove({ path: target, query: { owner } });
const after = await executor.accounts.list({ query: { owner } });
return { sameAccount: target.account === read.id && read.id === updated.id, label: updated.label, listed: listed.some((account) => account.id === target.account), removed: !after.some((account) => account.id === target.account) };`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* (yield* Evidence).json("managed-account.json", managedAccount.structuredContent);
        const managed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                sameAccount: Schema.Boolean,
                label: Schema.String,
                listed: Schema.Boolean,
                removed: Schema.Boolean,
              }),
            }),
          }),
        )(managedAccount.structuredContent);
        expect(managed.execution.value).toEqual({
          sameAccount: true,
          label: "Renamed docs account",
          listed: true,
          removed: true,
        });

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
