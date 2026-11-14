/** Search, describe and call reach app tools through MCP without an execute program. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Target } from "../support/platform.ts";

const source = `import { defineApp, mutation, query, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text back to the caller" },
    async (_ctx, { text }) => ({ text })),
  oversized: query({ input: object({}), description: "Return more than 100,000 bytes" },
    async () => ({ data: "x".repeat(150000) })),
  review: mutation({ input: object({ note: string() }), approval: always(), description: "Record a reviewed note" },
    async (_ctx, { note }) => ({ reviewed: note })),
}) }));`;

const SearchResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, input: Schema.String })),
});
const DescribeResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
  missing: Schema.Array(
    Schema.Struct({ path: Schema.String, matches: Schema.Array(Schema.String) }),
  ),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});

// A 1x1 PNG and a few bytes of WAV header, as an MCP tool returns them.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQWPX/PwAFgALJpImt0wAAAABJRU5ErkJggg==";
const wav = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
const mediaSource = `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  screenshot: query({ input: object({}), description: "Return a screenshot" },
    async () => ({ content: [{ type: "image", mimeType: "image/png", data: ${JSON.stringify(png)} }] })),
  recording: query({ input: object({}), description: "Return a recording" },
    async () => ({ content: [{ type: "audio", mimeType: "audio/wav", data: ${JSON.stringify(wav)} }] })),
  download: query({ input: object({}), description: "Return the screenshot's bytes as unpadded base64url, as file APIs do" },
    async () => ({ contentBase64url: ${JSON.stringify(png.replaceAll("/", "_").replaceAll("+", "-").replace(/=+$/u, ""))} })),
  lookalike: query({ input: object({}), description: "Return image-shaped data that is not base64" },
    async () => ({ type: "image", mimeType: "image/png", data: "not base64!" })),
}) }));`;

/** A personal access token and the app above, deployed for one scenario. */
const fixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const key = yield* body(
    Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "Direct calls",
    }),
  );
  yield* Effect.addFinalizer(() =>
    api
      .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
      .pipe(Effect.orDie),
  );
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Direct calls ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  return { key, app, organization: actors.organization.id };
});

/** Call one MCP tool and keep its structured result as evidence. */
const callTool = (
  client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>,
  label: string,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const result = yield* client.use(label, (client, signal) =>
      client.callTool({ name, arguments: args }, undefined, { signal }),
    );
    yield* evidence.json(
      `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
      result.structuredContent,
    );
    return result.structuredContent;
  });

layer(HostedLive, { excludeTestServices: true })("MCP direct calls", (it) => {
  it.effect(scenarios.mcpDirectCalls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const { key, app, organization } = yield* fixture;
        const client = yield* mcp.connect(key.key, "direct-calls", { organization });
        const tool = (label: string, name: string, args: Record<string, unknown>) =>
          callTool(client, label, name, args);

        const listed = yield* client.use("List the MCP tools", (client) => client.listTools());
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "call",
          "describe",
          "execute",
          "resume",
          "search",
          "skills",
        ]);

        // Search returns the exact paths call and execute both accept.
        const found = yield* Schema.decodeUnknownEffect(SearchResult)(
          yield* tool("Search the app", "search", { namespace: app.slug, query: "echo" }),
        );
        const echo = `tools[${JSON.stringify(app.slug)}].echo`;
        const oversized = `tools[${JSON.stringify(app.slug)}].oversized`;
        const review = `tools[${JSON.stringify(app.slug)}].review`;
        expect(found.items[0]).toMatchObject({ path: echo });
        expect(found.items[0]?.input).toContain("text");

        const described = yield* Schema.decodeUnknownEffect(DescribeResult)(
          yield* tool("Describe tools", "describe", { paths: [echo, `${echo}x`] }),
        );
        expect(described.items.map((item) => item.path)).toEqual([echo]);
        expect(described.items[0]?.signature).toContain("text");
        // An unknown path lists the closest paths, nearest first.
        expect(described.missing.map((entry) => entry.path)).toEqual([`${echo}x`]);
        expect(described.missing[0]?.matches[0]).toBe(echo);

        // One call returns its outcome alone.
        const single = yield* Schema.decodeUnknownEffect(Completed)(
          yield* tool("Call one tool", "call", { calls: { path: echo, input: { text: "hi" } } }),
        );
        expect(single.execution).toMatchObject({
          ok: true,
          value: { path: echo, ok: true, value: { text: "hi" } },
          toolCalls: [{ name: echo, outcome: "success" }],
        });

        // A batch keeps its order, one call failing does not stop the others, and a result over
        // 100,000 bytes comes back whole.
        const batch = yield* Schema.decodeUnknownEffect(Completed)(
          yield* tool("Call a batch", "call", {
            calls: [
              { path: echo, input: { text: "first" } },
              { path: `${echo}x`, input: {} },
              { path: oversized, input: {} },
              { path: echo, input: { text: "last" } },
            ],
          }),
        );
        expect(batch.execution.ok).toBe(true);
        expect(batch.execution.value).toMatchObject([
          { path: echo, ok: true, value: { text: "first" } },
          { path: `${echo}x`, ok: false, error: { kind: "UnknownTool" } },
          { path: oversized, ok: true, value: { data: "x".repeat(150_000) } },
          { path: echo, ok: true, value: { text: "last" } },
        ]);
        expect(JSON.stringify(batch.execution.value)).toContain(
          `"matches":[${JSON.stringify(echo)}`,
        );

        // An approval pauses the call; resume runs it once and returns its outcome.
        const pending = yield* Schema.decodeUnknownEffect(Pending)(
          yield* tool("Call a tool that needs approval", "call", {
            calls: { path: review, input: { note: "ship it" } },
          }),
        );
        const resumed = yield* Schema.decodeUnknownEffect(Completed)(
          yield* tool("Approve the call", "resume", {
            requestId: pending.requestId,
            response: { action: "accept" },
          }),
        );
        expect(resumed.execution).toMatchObject({
          ok: true,
          value: { path: review, ok: true, value: { reviewed: "ship it" } },
          toolCalls: [{ name: review, outcome: "success" }],
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpMediaContent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const { key, organization } = yield* fixture;
        const prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Media ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: mediaSource }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "media-content", { organization });
        const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
        const run = (label: string, name: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name, arguments: args }, undefined, { signal }),
            );
            yield* evidence.json(
              `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
              result,
            );
            const [text, ...media] = result.content as ReadonlyArray<Record<string, unknown>>;
            const completed = yield* Schema.decodeUnknownEffect(Completed)(
              result.structuredContent,
            );
            // The text block repeats the structured result, which keeps no base64.
            expect(text).toMatchObject({ type: "text" });
            expect(JSON.parse(String(text?.text))).toEqual(result.structuredContent);
            expect(String(text?.text)).not.toContain(png);
            expect(String(text?.text)).not.toContain(wav);
            return { completed, media };
          });

        // A direct call's image reaches the client as an image block; the result keeps its index.
        const called = yield* run("Call a tool that returns an image", "call", {
          calls: { path: tool("screenshot"), input: {} },
        });
        expect(called.media).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
        expect(called.completed.execution).toMatchObject({
          ok: true,
          value: {
            path: tool("screenshot"),
            ok: true,
            value: { content: [{ type: "image", mimeType: "image/png", contentIndex: 1 }] },
          },
        });

        // A program's result sends each distinct image or audio block once, in first-seen order.
        // A program can wrap bytes a tool returns in another shape, here unpadded base64url, and
        // they are sent in the standard form: the same screenshot, so the same block. Data that
        // is not base64 is not media and stays in the result as the tool returned it.
        const executed = yield* run("Execute a program that returns media", "execute", {
          code: `const shot = await ${tool("screenshot")}({});
const audio = await ${tool("recording")}({});
const file = await ${tool("download")}({});
return { first: shot.content[0], audio: audio.content[0], again: shot,
  wrapped: { type: "image", mimeType: "image/png", data: file.contentBase64url },
  lookalike: await ${tool("lookalike")}({}) };`,
        });
        expect(executed.media).toEqual([
          { type: "image", mimeType: "image/png", data: png },
          { type: "audio", mimeType: "audio/wav", data: wav },
        ]);
        expect(executed.completed.execution).toMatchObject({
          ok: true,
          value: {
            first: { type: "image", mimeType: "image/png", contentIndex: 1 },
            audio: { type: "audio", mimeType: "audio/wav", contentIndex: 2 },
            again: { content: [{ type: "image", mimeType: "image/png", contentIndex: 1 }] },
            wrapped: { type: "image", mimeType: "image/png", contentIndex: 1 },
            lookalike: { type: "image", mimeType: "image/png", data: "not base64!" },
          },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpNativeCallApproval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const { key, app, organization } = yield* fixture;
        const client = yield* mcp.connect(key.key, "native-direct-calls", {
          organization,
          mode: "native",
        });
        const review = `tools[${JSON.stringify(app.slug)}].review`;

        // The client confirms each call itself: call is marked destructive and open-world.
        const listed = yield* client.use("List the MCP tools", (client) => client.listTools());
        expect(listed.tools.find((tool) => tool.name === "call")?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        });

        // That confirmation answers the app's approval policy, so call asks nothing more.
        const called = yield* Schema.decodeUnknownEffect(Completed)(
          yield* callTool(client, "Call a tool that needs approval", "call", {
            calls: { path: review, input: { note: "native" } },
          }),
        );
        expect(called.execution).toMatchObject({
          ok: true,
          value: { path: review, ok: true, value: { reviewed: "native" } },
          toolCalls: [{ name: review, outcome: "success" }],
        });
        expect(yield* client.elicitationCount).toBe(0);

        // A program has no per-call confirmation, so execute still asks through the client.
        const executed = yield* Schema.decodeUnknownEffect(Completed)(
          yield* callTool(client, "Execute a tool that needs approval", "execute", {
            code: `return await ${review}({ note: "program" })`,
          }),
        );
        expect(executed.execution).toMatchObject({ ok: true, value: { reviewed: "program" } });
        expect(yield* client.elicitationCount).toBe(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpNestedExecutorResult.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const origin = (yield* Target).metadata.origin;
        const { key, app, organization } = yield* fixture;
        const prefix = `/api/organizations/${organization}`;
        // An app that reaches this same Executor through its MCP server, as a remote MCP router.
        // Its account holds the access token the inner Executor accepts.
        const name = `Nested executor ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, object, secrets, string } from "apps";
import { mcpRouter } from "apps/mcp";
const service = defineProvider({ name: ${JSON.stringify(name)}, hosts: [${JSON.stringify(new URL(origin).host)}], auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) }),
} });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts }, signal }) => ({
  tools: await mcpRouter({
    url: ${JSON.stringify(`${origin}/mcp`)},
    account: accounts.service,
    headers: { Authorization: "Bearer " + accounts.service.fields.token, "X-Executor-Organization": ${JSON.stringify(organization)} },
    signal,
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const outer = yield* body(App, deployed);
        const outerPath = `${prefix}/apps/${outer.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", outerPath).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(outerPath, "user", "service"),
            {},
          ),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label: "Inner Executor", fields: { token: Redacted.value(key.key) } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
        );

        const client = yield* mcp.connect(key.key, "nested-executor", { organization });
        const echo = `tools[${JSON.stringify(app.slug)}].echo`;
        const nestedCall = `tools[${JSON.stringify(outer.slug)}].call`;
        const id = randomUUID();
        const marker = `say "nested" ${id}`;
        const result = yield* client.use("Call Executor through Executor", (client, signal) =>
          client.callTool(
            {
              name: "call",
              arguments: {
                calls: {
                  path: nestedCall,
                  input: { calls: { path: echo, input: { text: marker } } },
                },
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("nested-executor-result.json", result);
        const completed = yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent);
        // The inner Executor's text block only repeats its structured result, so the outer
        // Executor keeps the structured result alone.
        expect(completed.execution).toMatchObject({
          ok: true,
          value: {
            path: nestedCall,
            ok: true,
            value: {
              content: [],
              structuredContent: {
                status: "completed",
                execution: { ok: true, value: { path: echo, ok: true, value: { text: marker } } },
              },
            },
          },
        });
        // Each hop carries the payload once, so nesting does not multiply the agent's context.
        const nested = JSON.stringify(completed.execution.value);
        expect(nested.split(id).length - 1).toBe(1);
        expect(nested).toContain(JSON.stringify(marker));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
