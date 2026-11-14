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
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

const App = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  activeVersion: Schema.String,
});
const Published = Schema.Struct({ app: App });
const Index = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      app: Schema.Struct({ id: Schema.String, slug: Schema.String }),
      version: Schema.String,
      revision: Schema.String,
    }),
  ),
});
const Document = Schema.Struct({
  content: Schema.String,
  version: Schema.String,
  files: Schema.Array(Schema.String),
});
const Listed = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
const SkillsInput = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
/**
 * The `skills` inputs a text shows. The `skills` description shows them as bare objects; every
 * other text shows a concrete call as `skills({...})`. Keys may be unquoted and strings may use
 * single quotes, as in the descriptions.
 */
const skillsExamples = (text: string, bare: boolean) =>
  [...text.matchAll(bare ? /\{[^{}]*\}/g : /skills\((\{[^{}]*\})\)/g)].map((match) =>
    (match[1] ?? match[0])
      .replaceAll("'", '"')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'),
  );
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
        expect(copy.activeVersion).not.toBe(app.activeVersion);
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
        expect(guide.version).toMatch(
          yield* wholeStringInputPattern(listed.tools, "skills", "version"),
        );
        expect(guide.revision).toMatch(
          yield* wholeStringInputPattern(listed.tools, "skills", "revision"),
        );
        const selected = yield* client.use(
          "Read the guide with its returned version and revision",
          (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: guide.app.slug,
                  name: guide.name,
                  version: guide.version,
                  revision: guide.revision,
                },
              },
              undefined,
              { signal },
            ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(selected.structuredContent)).version,
        ).toBe(guide.version);
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
                version: guideDocument.version,
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
        // Every file the guide links is listed and readable, including the nested upgrade guides.
        const linked = [...guideDocument.content.matchAll(/\]\(([^)\s#:]+\.md)\)/g)].map(
          (match) => match[1] ?? "",
        );
        expect(linked).toEqual(expect.arrayContaining(["upgrades/0.0.1-beta.90.md"]));
        expect(guideDocument.files).toEqual(expect.arrayContaining(linked));
        for (const file of new Set(linked)) {
          const read = yield* client.use(`Read the linked ${file} on local`, (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: guide.app.slug,
                  name: "app-authoring",
                  version: guideDocument.version,
                  file,
                },
              },
              undefined,
              { signal },
            ),
          );
          expect(read.isError, JSON.stringify(read.content)).not.toBe(true);
          expect(
            (yield* Schema.decodeUnknownEffect(Document)(read.structuredContent)).content,
          ).not.toBe("");
        }
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
        expect(source.id).toBe(guideDocument.version);
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
          "Follow a reference using the original version",
          (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: app.slug,
                  name: "app-authoring",
                  file: "references/example.md",
                  version: original.version,
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
        expect(copiedDocument.version).toBe(copy.activeVersion);
        expect(copiedDocument.content).toContain("Version one.");
        // Every document needs an app. There is no unscoped authoring-guide fallback.
        for (const input of [
          { file: "SKILL.md" },
          { name: "app-authoring" },
          { name: "app-authoring", version: original.version },
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
  it.effect(scenarios.localSkillsInputSchema.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        // MCP tool input schemas use JSON Schema 2020-12, which this validator implements.
        const validator = new CfWorkerJsonSchemaValidator();
        const client = yield* mcp.connect(target.apiKey, "skills-input-schema");
        const call = (step: string, input: Record<string, unknown>) =>
          client.use(step, (client, signal) =>
            client.callTool({ name: "skills", arguments: input }, undefined, { signal }),
          );
        // Every text an agent reads before calling skills: each mode's tool descriptions and
        // the server instructions, which are the Executor app's entry skill.
        const texts: { readonly source: string; readonly examples: ReadonlyArray<string> }[] = [];
        let advertised: Record<string, unknown> | undefined;
        for (const mode of ["model", "native", "browser"] as const) {
          const connection = yield* mcp.connect(target.apiKey, `skills-guidance-${mode}`, {
            mode,
          });
          const listed = yield* Schema.decodeUnknownEffect(Listed)(
            yield* connection.use(`List the ${mode} mode tools`, (client) => client.listTools()),
          );
          for (const tool of listed.tools) {
            if (tool.name === "skills") advertised ??= tool.inputSchema;
            texts.push({
              source: `${mode} ${tool.name} description`,
              examples: skillsExamples(tool.description ?? "", tool.name === "skills"),
            });
          }
          const instructions = yield* connection.use(
            `Read the ${mode} mode instructions`,
            (client) => Promise.resolve(client.getInstructions() ?? ""),
          );
          texts.push({
            source: `${mode} instructions`,
            examples: skillsExamples(instructions, false),
          });
        }
        if (advertised === undefined)
          return yield* Effect.die("Every MCP mode must list the skills tool");
        const accepts = validator.getValidator(advertised);

        // The advertised schema and the runtime agree on every read shape, and both refuse a
        // document or reference without its app or skill.
        const index = yield* Schema.decodeUnknownEffect(Index)(
          (yield* call("List every skill", {})).structuredContent,
        );
        const guide = index.skills.find(
          (skill) => skill.name === "executor" && skill.app.slug === "executor",
        );
        if (guide === undefined)
          return yield* Effect.die("The Executor app must publish its entry skill");
        const shapes: ReadonlyArray<readonly [Record<string, unknown>, boolean]> = [
          [{}, true],
          [{ app: "executor" }, true],
          [{ app: "executor", name: "executor" }, true],
          [{ app: "executor", name: "executor", file: "feedback.md" }, true],
          [{ name: "executor" }, false],
          [{ name: "executor", version: guide.version }, false],
          [{ revision: guide.revision }, false],
          [{ file: "feedback.md" }, false],
          [{ app: "executor", file: "feedback.md" }, false],
        ];
        for (const [input, valid] of shapes) {
          const result = yield* call(`Call skills with ${JSON.stringify(input)}`, input);
          expect({
            input,
            schema: accepts(input).valid,
            runtime: result.isError !== true,
          }).toEqual({ input, schema: valid, runtime: valid });
        }
        const refused = yield* call("Read a skill without its app", { name: "executor" });
        // The refusal names the call that works.
        expect(refused.content).toEqual([
          {
            type: "text",
            text: expect.stringContaining('{app: "executor", name: "executor"}'),
          },
        ]);

        // Every Executor app skill document and reference: the guidance agents read next.
        const listed = yield* Schema.decodeUnknownEffect(Index)(
          (yield* call("List the Executor app's skills", { app: guide.app.slug }))
            .structuredContent,
        );
        for (const skill of listed.skills) {
          const document = yield* Schema.decodeUnknownEffect(Document)(
            (yield* call(`Read the ${skill.name} skill`, { app: skill.app.slug, name: skill.name }))
              .structuredContent,
          );
          texts.push({
            source: `${skill.name}/SKILL.md`,
            examples: skillsExamples(document.content, false),
          });
          for (const file of document.files.filter((file) => file !== "SKILL.md")) {
            const reference = yield* Schema.decodeUnknownEffect(Document)(
              (yield* call(`Read ${skill.name}/${file}`, {
                app: skill.app.slug,
                name: skill.name,
                file,
                version: skill.version,
                revision: skill.revision,
              })).structuredContent,
            );
            texts.push({
              source: `${skill.name}/${file}`,
              examples: skillsExamples(reference.content, false),
            });
          }
        }
        // The texts that send agents to skills give a call they can make.
        for (const source of [
          "model skills description",
          "model execute description",
          "native execute description",
          "browser execute description",
          "model instructions",
        ])
          expect(
            texts.find((text) => text.source === source)?.examples.length ?? 0,
            source,
          ).toBeGreaterThan(0);
        const examples = new Map<string, string>();
        for (const text of texts)
          for (const example of text.examples)
            if (!examples.has(example)) examples.set(example, text.source);
        for (const [example, source] of examples) {
          const input = yield* Schema.decodeUnknownEffect(SkillsInput)(example);
          expect(accepts(input).valid, `${source}: ${example}`).toBe(true);
          const result = yield* call(`Run the ${source} example ${example}`, input);
          expect(
            result.isError,
            `${source}: ${example} ${JSON.stringify(result.content)}`,
          ).not.toBe(true);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
