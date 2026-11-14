/**
 * Executor sets no limit on the size of an `execute` or `call` result. A result far over the
 * 100,000 bytes Executor once cut values at comes back whole, as a success the agent can parse.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { expectUnknownOutcome } from "../support/write-outcome.ts";
import { scenarios } from "../test-plan.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, number, object, query, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  rows: query({ input: object({ count: number() }), description: "List synthetic rows" },
    async (_ctx, { count }) => Array.from({ length: count }, (_, id) => ({ id, note: "row " + id + " " + "n".repeat(80) }))),
}) }));`,
  },
  appsManifest,
];

const App = Schema.Struct({ id: Schema.String, slug: Schema.String });

/** The rows `rows({ count })` returns. */
const rows = (count: number) =>
  Array.from({ length: count }, (_, id) => ({ id, note: `row ${id} ${"n".repeat(80)}` }));

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    logs: Schema.optional(Schema.Array(Schema.String)),
    truncated: Schema.optional(Schema.Boolean),
  }),
});
/** The text an MCP client reads when it ignores structured content. */
const Text = Schema.Struct({
  content: Schema.Tuple([Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })]),
});

type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

/** Large program values, logs and direct calls reach the agent whole and parse. */
const checkLargeResults = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const tool = `tools[${JSON.stringify(slug)}].rows`;
    const run = (step: string, name: string, args: Record<string, unknown>) =>
      client
        .use(step, (client, signal) =>
          client.callTool({ name, arguments: args }, undefined, { signal, timeout: 55_000 }),
        )
        .pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const { execution } = yield* Schema.decodeUnknownEffect(Completed)(
                result.structuredContent,
              );
              // The text block is the same result as JSON, whole, so it parses.
              const { content } = yield* Schema.decodeUnknownEffect(Text)(result);
              expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
              const bytes = Buffer.byteLength(content[0].text);
              yield* evidence.json(`${step.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`, {
                ok: execution.ok,
                truncated: execution.truncated ?? false,
                textBytes: bytes,
              });
              return execution;
            }),
          ),
        );

    // A tool's large result beside a value of the program's own, as the reports returned: about
    // 1.6 MB of JSON, sixteen times the old 100,000-byte limit. It arrives whole, not as a cut
    // string, and nothing says it was truncated.
    const listed = rows(15_000);
    const expected = { listed, count: listed.length };
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(1_500_000);
    const big = yield* run("Return a large tool result", "execute", {
      code: `const listed = await ${tool}({ count: 15000 });
return { listed, count: listed.length };`,
    });
    expect(big.ok).toBe(true);
    expect(big.truncated).toBeUndefined();
    expect(big.value).toEqual(expected);

    // Multi-byte text and long logs come back whole too.
    const wide = yield* run("Return wide characters", "execute", {
      code: `return "é".repeat(60000);`,
    });
    expect(wide).toMatchObject({ ok: true, value: "é".repeat(60_000) });
    const noisy = yield* run("Log far more than 100,000 bytes", "execute", {
      code: `for (let n = 0; n < 3000; n++) console.log("line " + n + " " + "l".repeat(90));
return { done: true };`,
    });
    expect(noisy).toMatchObject({ ok: true, value: { done: true } });
    expect(noisy.truncated).toBeUndefined();
    expect(noisy.logs).toHaveLength(3000);
    expect(noisy.logs?.at(-1)).toBe(`line 2999 ${"l".repeat(90)}`);

    // A direct call returns its large result whole as well.
    const direct = yield* run("Call a large tool directly", "call", {
      calls: { path: tool, input: { count: 15000 } },
    });
    expect(direct).toMatchObject({ ok: true, value: { ok: true } });
    expect(direct.value).toEqual({ path: tool, ok: true, value: listed });
  });

layer(TestLive, { excludeTestServices: true })("MCP large result", (it) => {
  it.effect(scenarios.mcpLargeResult.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const deployed = yield* agent.send("POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Large result ${randomUUID().slice(0, 8)}`,
          files,
        });
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          agent.send("DELETE", `/v1/apps/${app.id}`).pipe(
            Effect.map((response) => expect(response.status).toBe(200)),
            Effect.orDie,
          ),
        );
        const client = yield* mcp.connect(target.apiKey, "mcp-large-result");
        yield* checkLargeResults(client, app.slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

/**
 * An app that imitates the runtime's 32 MiB Workers RPC error once, without any large value: its
 * bridge's reply decoding throws that text when the tool's error carries a marker. `huge` returns a
 * real value over the limit, and `forgedWrite` imitates it from a mutation.
 */
const forgingFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, mutation, number, object, query, router } from "apps";
const forged = new Set();
const json = Response.prototype.json;
Response.prototype.json = async function () {
  const result = await json.call(this);
  if (result?.error?.message === "FORGED_RPC_SIZE")
    throw new Error("Serialized RPC arguments or return values are limited to 33554432 bytes");
  return result;
};
const once = (name, value) => {
  if (forged.has(name)) return value;
  forged.add(name);
  throw new Error("FORGED_RPC_SIZE");
};
export default defineApp({}, async () => ({ tools: router({
  forged: query({ input: object({}) }, async () => once("forged", 123)),
  forgedWrite: mutation({ input: object({}) }, async () => once("forgedWrite", "written")),
  huge: query({ input: object({ n: number() }) }, async (_ctx, { n }) => "x".repeat(n)),
}) }));`,
  },
  appsManifest,
];

/** A program that failed on a tool's error, with the agent-facing explanation and retry policy. */
const ToolFailed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({
        code: Schema.String,
        retryable: Schema.Boolean,
        recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      }),
    }),
  }),
});

layer(TestLive, { excludeTestServices: true })("MCP forged size limit", (it) => {
  it.effect(scenarios.mcpRpcLimitForged.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient,
          evidence = yield* Evidence,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", name: `Forged limit ${randomUUID().slice(0, 8)}`, files: forgingFiles },
          headers,
        );
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(
            Effect.map((response) => expect(response.status).toBe(200)),
            Effect.orDie,
          ),
        );
        const client = yield* mcp.connect(target.apiKey, "mcp-forged-size-limit");
        const tools = `tools[${JSON.stringify(app.slug)}]`;
        const execute = (step: string, code: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, {
                signal,
                timeout: 55_000,
              }),
            )
            .pipe(
              Effect.tap((result) =>
                evidence.json(
                  `${step.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
                  result.structuredContent,
                ),
              ),
              Effect.map((result) => result.structuredContent),
            );
        const failure = (step: string, code: string) =>
          execute(step, code).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ToolFailed)),
            Effect.map(({ execution }) => execution.error),
          );

        // The size error reaches Executor through the app's Worker, which can produce the same
        // text, so the host presents it as a likely cause and keeps a read's retry policy.
        const forgedRead = `return await ${tools}.forged({});`;
        const forged = yield* failure("Call a query that imitates the size error", forgedRead);
        expect(forged.response).toMatchObject({ code: "ToolCallFailed", retryable: true });
        expect(forged.message).toContain("looks like");
        expect(forged.message).toContain("32 MiB");
        expect(forged.response.recovery.instructions).not.toContain("expected to fail");
        // Repeating the unchanged call succeeds: nothing about its size made it fail.
        expect(
          yield* execute("Repeat the same call unchanged", forgedRead).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Completed)),
            Effect.map(({ execution }) => execution),
          ),
        ).toMatchObject({ ok: true, value: 123 });

        // A real value over the limit fails with the same text, so it reads the same way.
        const real = yield* failure(
          "Return a value over the Workers RPC limit",
          `return await ${tools}.huge({ n: ${35 * 1024 * 1024} });`,
        );
        expect(real.response).toEqual(forged.response);

        // A mutation's lost result is never offered as an unchanged repeat.
        const write = yield* failure(
          "Call a mutation that imitates the size error",
          `return await ${tools}.forgedWrite({});`,
        );
        expect(write.response).toMatchObject({ code: "ToolCallFailed", retryable: false });
        expectUnknownOutcome(write.response.recovery);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

/** Deploy the rows app in the case's organization and connect an MCP client with an API key. */
const hostedClient = (name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
    );
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
      }).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key, name.toLowerCase().replaceAll(" ", "-"), {
      organization: actors.organization.id,
    });
    return { client, slug: app.slug };
  });

layer(HostedLive, { excludeTestServices: true })("Hosted MCP large result", (it) => {
  it.effect(scenarios.mcpLargeResultHosted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedClient("Large result");
        yield* checkLargeResults(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpLargeResultMemoryLimit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const { client } = yield* hostedClient("Memory limit");
        // A 40 MiB value, held several times over while the session object sends it, passes the
        // object's 128 MB memory limit; 30 MiB comes back whole. The client is told so at once
        // instead of waiting for an answer that will not come.
        const outcome = yield* client.use("Return 40 MiB from a program", (client, signal) =>
          client
            .callTool(
              { name: "execute", arguments: { code: `return "x".repeat(${40 * 1024 * 1024});` } },
              undefined,
              { signal, timeout: 55_000 },
            )
            .then(
              (result) => ({ answered: true as const, isError: result.isError === true }),
              (error: unknown) => ({
                answered: false as const,
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
        );
        yield* evidence.json("memory-limit.json", outcome);
        expect(outcome).toMatchObject({
          answered: false,
          message: expect.stringContaining("exceeded Cloudflare's 128 MB memory limit"),
        });
        expect(outcome.answered === false && outcome.message).toContain("Return less");
        // The session keeps working once the object restarts.
        const after = yield* client.use("Run a small program afterwards", (client, signal) =>
          client.callTool({ name: "execute", arguments: { code: "return 1;" } }, undefined, {
            signal,
            timeout: 55_000,
          }),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(after.structuredContent)).execution,
        ).toMatchObject({ ok: true, value: 1 });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
