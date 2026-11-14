/** A broad tools.search stays inside its page budget; describe returns full detail. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** UTF-8 bytes of JSON one search page holds at most. */
const pageBytes = 25_000;
const records = 100;
const kinds = 300;

/**
 * A hundred tools whose descriptions carry the same upstream instructions after their first line and
 * whose output types are large unions, the shape that made broad searches overflow, and one tool
 * whose input type alone is longer than a search item keeps.
 */
const source = `
import { defineApp, defineProvider, jsonSchema, object, query, router, secrets, string } from "apps";
const service = defineProvider({ name: "Concise fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
const output = jsonSchema({ anyOf: Array.from({ length: 30 }, (_, n) => ({
  type: "object",
  properties: { ["outputOnlyField" + n]: { type: "string", description: "Output variant " + n + " of a synthetic record, returned when the record has that shape." } },
  required: ["outputOnlyField" + n],
})) });
const instructions = "Upstream instructions: always confirm the record identifier with the user before reading it, never retry a failed read more than once, and report rate limits verbatim.";
const tools = {};
for (let n = 0; n < ${records}; n++)
  tools["record" + n] = query({
    description: "Read synthetic concise record " + n + ".\\n\\n" + instructions,
    input: jsonSchema({ type: "object", properties: { id: { type: "string", description: "Record identifier" } }, required: ["id"], additionalProperties: false }),
    output,
  }, async (_ctx, input) => ({ outputOnlyField0: input.id }));
tools.wide = query({
  description: "Filter synthetic concise records by kind.",
  input: jsonSchema({ type: "object", properties: { kind: { enum: Array.from({ length: ${kinds} }, (_, n) => "kind-value-" + n) } }, required: ["kind"] }),
}, async () => []);
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router(tools) }));
`;

const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Item = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  input: Schema.String,
  inputTruncated: Schema.optional(Schema.Literal(true)),
});
const Page = Schema.Struct({
  items: Schema.Array(Item),
  namespaces: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      app: Schema.String,
      accounts: Schema.optional(Schema.String),
    }),
  ),
  remaining: Schema.Number,
  next: Schema.NullOr(
    Schema.Struct({
      namespace: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number),
      offset: Schema.Number,
    }),
  ),
});
const Described = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  missing: Schema.Array(
    Schema.Struct({ path: Schema.String, matches: Schema.Array(Schema.String) }),
  ),
});
const Executed = <A, I>(value: Schema.Codec<A, I>) =>
  Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({
      ok: Schema.Literal(true),
      value,
      truncated: Schema.optional(Schema.Boolean),
    }),
  });

layer(TestLive, { excludeTestServices: true })("MCP search concise", (it) => {
  it.effect(scenarios.mcpSearchConcise.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient,
          evidence = yield* Evidence,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const { app } = yield* body(
          Deployed,
          yield* agent.send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Concise search ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          }),
        );
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect((yield* agent.send("DELETE", `/v1/apps/${app.id}`)).status).toBe(200);
            for (const account of accounts)
              expect((yield* agent.send("DELETE", `/v1/accounts/${account}`)).status).toBe(200);
          }).pipe(Effect.orDie),
        );
        // Two accounts connected from the app for its one plain requirement, the newer with a
        // description. Connecting from the app links the account in place of the one linked before,
        // which stays saved.
        for (const [label, description] of [
          ["Sandbox key", null],
          ["Work key", "Reads only."],
        ] as const) {
          const account = yield* connectLocalAccount(
            agent,
            {
              app: app.id,
              requirement: "service",
              method: "key",
              label,
              fields: { token: `synthetic-${randomUUID()}` },
            },
            headers,
          );
          accounts.push(account.id);
          if (description !== null)
            expect(
              (yield* agent.send("PATCH", `/v1/accounts/${account.id}`, { description })).status,
            ).toBe(200);
        }
        const [sandbox, work] = accounts;
        if (work === undefined || sandbox === undefined)
          return yield* Effect.die("Account fixtures missing");

        const client = yield* mcp.connect(target.apiKey, "mcp-search-concise");
        const execute = <A, I>(step: string, code: string, value: Schema.Codec<A, I>) =>
          client
            .use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Executed(value))(result.structuredContent),
              ),
              Effect.map(({ execution }) => execution),
            );
        const namespace = JSON.stringify(app.slug);
        const tools = records + 1;

        // A broad search asks for more items than fit: the page stops at its byte budget, says how
        // many matches remain and how to continue, and is never truncated by execute.
        const first = yield* execute(
          "Search every tool of the app at once",
          `return await tools.search({ namespace: ${namespace}, limit: 100 });`,
          Schema.Unknown,
        );
        expect(first.truncated).toBeUndefined();
        yield* evidence.json("search-first-page.json", first.value);
        const text = JSON.stringify(first.value);
        const page = yield* Schema.decodeUnknownEffect(Page)(first.value);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(pageBytes);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThan(tools);
        expect(page.remaining).toBe(tools - page.items.length);
        expect(page.next).toEqual({ namespace: app.slug, limit: 100, offset: page.items.length });
        // Items are concise: a one-line description and the input type, never the output type or
        // the instructions after the first line.
        expect(text).not.toContain("outputOnlyField");
        expect(text).not.toContain("Upstream instructions");
        expect(text).not.toContain('"signature"');
        // Calls never choose accounts: the input is the tool's own, without `$accounts`.
        const record = page.items.find((item) => item.path.endsWith(".record0"));
        expect(record).toMatchObject({
          description: "Read synthetic concise record 0.",
          input: "{ id: string }",
        });
        expect(text).not.toContain("$accounts");
        // Each tool is one item at the app's path, and the app is listed once with the account
        // each requirement uses: the plain requirement's one linked account, not the replaced one.
        expect(page.namespaces).toEqual([
          {
            path: `tools[${namespace}]`,
            app: expect.any(String),
            accounts: `service: ${work} (Work key: Reads only.)`,
          },
        ]);
        expect(text).not.toContain(sandbox);
        expect(text.split("Work key: Reads only.").length - 1).toBe(1);

        // Following `next` lists every tool exactly once.
        const all = yield* execute(
          "Page through every match",
          `const items = [];
for (let page = await tools.search({ namespace: ${namespace}, limit: 100 }); ; page = await tools.search(page.next)) {
  items.push(...page.items);
  if (page.next === null) break;
}
return { items, namespaces: [], remaining: 0, next: null };`,
          Page,
        );
        const paths = all.value.items.map((item) => item.path);
        expect(all.value.items).toHaveLength(tools);
        expect(new Set(paths).size).toBe(tools);
        const wide = all.value.items.find((item) => item.path.endsWith(".wide"));
        expect(wide?.inputTruncated).toBe(true);
        expect(wide?.input).not.toContain(`kind-value-${kinds - 1}`);
        if (record === undefined || wide === undefined)
          return yield* Effect.die("Search did not list the fixture tools");

        // Describe returns what search leaves out: the whole description and input, and the
        // output type. A path that names no tool comes back with the closest paths.
        const unknown = record.path.replace(/record0$/, "recrod0");
        const described = yield* execute(
          "Describe exact paths",
          `return await tools.search.describe({ paths: ${JSON.stringify([record.path, wide.path, unknown])} });`,
          Described,
        );
        expect(described.value.items.map((item) => item.path)).toEqual([record.path, wide.path]);
        const [full, wideFull] = described.value.items;
        expect(full?.description).toContain("Upstream instructions");
        expect(full?.signature).toContain(`outputOnlyField29`);
        expect(wideFull?.signature).toContain(`kind-value-${kinds - 1}`);
        expect(described.value.missing).toEqual([
          { path: unknown, matches: expect.arrayContaining([record.path]) },
        ]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
