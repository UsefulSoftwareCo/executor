/** Agent names stay readable while each callable closes over immutable app and operation identities. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppId, AppSlug, appSlug, DeploymentId, ToolName } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { defaultMcpLimits, execute, type McpBackend } from "../src/index.ts";

const first = { id: AppId.make("app_one"), name: "Axiom", slug: AppSlug.make("axiom") };
const second = {
  id: AppId.make("app_two"),
  name: "Support inbox",
  slug: AppSlug.make("support-inbox"),
};
const names = [
  "queries.search",
  "queries.projects.list",
  "mutations.createItem",
  "queries.constructor",
  "queries.%constructor",
];
const setup = (apps: readonly (typeof first)[]) => {
  const calls: Array<{ app: string; tool: string }> = [];
  const backend: McpBackend<Error> = {
    listSkills: () => Effect.die("Unexpected skill listing"),
    readSkill: () => Effect.die("Unexpected skill read"),
    authorizeElicitation: () => Effect.void,
    listApps: () => Effect.succeed(apps),
    listTools: ({ app }) =>
      Effect.succeed({
        deployment: DeploymentId.make("dpl_fixture"),
        items: names.map((name) => ({
          app,
          deployment: DeploymentId.make("dpl_fixture"),
          name: ToolName.make(name),
          description: name,
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          ...(name === "queries.search"
            ? {
                outputSchema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { type: "string" } },
                    next: { anyOf: [{ type: "string" }, { type: "null" }] },
                  },
                  required: ["items", "next"],
                  additionalProperties: false,
                },
              }
            : {}),
        })),
      }),
    callTool: ({ app, tool }) =>
      Effect.sync(() => {
        calls.push({ app, tool });
        return { status: "completed" as const, value: { app, tool } };
      }),
    resumeInvocation: () => Effect.die("No pending approval in this test"),
  };
  return {
    calls,
    run: (code: string) => Effect.runPromise(execute(backend, defaultMcpLimits, code)),
  };
};

test("search returns nested slug paths and calls retain their original app IDs and operation names", async () => {
  const { calls, run } = setup([first, second]);
  const searched = await run(
    'return await tools.search({ namespace: "axiom.queries", limit: 20 })',
  );
  assert.ok(searched.execution.ok);
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
    }),
  )(searched.execution.value);
  assert.ok(result.items.some((item) => item.path === "tools.axiom.queries.search"));
  assert.ok(result.items.some((item) => item.path === "tools.axiom.queries.projects.list"));
  assert.ok(
    result.items.every((item) => !item.path.includes("app_one") && !item.path.includes("%2E")),
  );
  assert.ok(result.items.every((item) => item.signature.includes(item.path)));
  const signature = result.items.find(
    (item) => item.path === "tools.axiom.queries.search",
  )?.signature;
  assert.ok(signature);
  assert.ok(signature.includes("items: Array<string>"), signature);
  assert.ok(signature.includes("next: string | null"), signature);
  assert.ok(
    result.items
      .find((item) => item.path.endsWith("projects.list"))
      ?.signature.includes("Promise<unknown>"),
  );
  const called = await run(`return await Promise.all([
    tools.axiom.queries.search({ query: "errors" }),
    tools.axiom.queries.projects.list({ query: "projects" }),
    tools["support-inbox"].mutations.createItem({ query: "new" }),
    tools.axiom.queries["%constructor"]({ query: "reserved upstream name" }),
    tools.axiom.queries["%25constructor"]({ query: "literal percent" }),
  ])`);
  assert.ok(called.execution.ok, JSON.stringify(called));
  assert.deepEqual(calls, [
    { app: first.id, tool: "queries.search" },
    { app: first.id, tool: "queries.projects.list" },
    { app: second.id, tool: "mutations.createItem" },
    { app: first.id, tool: "queries.constructor" },
    { app: first.id, tool: "queries.%constructor" },
  ]);
});

test("a backend combining owners cannot silently select between duplicate slugs", async () => {
  const { calls, run } = setup([first, { ...second, slug: first.slug }]);
  const searched = await run('return await tools.search({ query: "Axiom" })');
  assert.deepEqual(
    searched.unavailableApps.map((app) => [app.app, app.reason]),
    [
      [first.id, "AppSlugAmbiguous"],
      [second.id, "AppSlugAmbiguous"],
    ],
  );
  const called = await run('return await tools.axiom.queries.search({ query: "private" })');
  assert.equal(called.execution.ok, false);
  assert.deepEqual(calls, []);
});

test("renaming moves the public namespace while calls retain the same app ID", async () => {
  const visible = [first];
  const { calls, run } = setup(visible);
  assert.ok(
    (await run('return await tools.axiom.queries.search({ query: "before" })')).execution.ok,
  );
  const name = "Work Axiom";
  visible[0] = { ...first, name, slug: appSlug(name) };
  assert.equal(
    (await run('return await tools.axiom.queries.search({ query: "stale" })')).execution.ok,
    false,
  );
  const current = await run('return await tools["work-axiom"].queries.search({ query: "after" })');
  assert.ok(current.execution.ok);
  assert.deepEqual(calls, [
    { app: first.id, tool: "queries.search" },
    { app: first.id, tool: "queries.search" },
  ]);
  const discovery = await run(
    'return await tools.search({ namespace: "work-axiom.queries", limit: 20 })',
  );
  assert.ok(discovery.execution.ok);
  const result = Schema.decodeUnknownSync(
    Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
  )(discovery.execution.value);
  assert.ok(result.items.some((item) => item.path === 'tools["work-axiom"].queries.search'));
});
