import { AppSlug } from "@executor-js/sdk/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppId, DeploymentId, ToolName } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { defaultMcpLimits, execute, type McpBackend } from "../src/index.ts";

// A product can add a typed failure without adding an MCP translation case.
class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  name: Schema.String,
  message: Schema.String,
  upstreamBody: Schema.String,
  cause: Schema.Unknown,
}) {}

const app = AppId.make("app_fixture");
const deployment = DeploymentId.make("dpl_fixture");
const backend: McpBackend<ProviderUnavailable> = {
  listSkills: () => Effect.die("Unexpected skill listing"),
  readSkill: () => Effect.die("Unexpected skill read"),
  authorizeElicitation: () => Effect.void,
  listTargets: () => Effect.succeed([{ kind: "app" }]),
  listApps: () => Effect.succeed([{ id: app, slug: AppSlug.make("fixture"), name: "Fixture" }]),
  listTools: () =>
    Effect.succeed({
      deployment,
      items: [
        {
          app,
          deployment,
          name: ToolName.make("hello"),
          description: "Greeting",
          inputSchema: { type: "object" },
        },
      ],
    }),
  callTool: () => Effect.succeed({ status: "completed", value: null }),
  resumeInvocation: () => Effect.die("No pending calls in this test"),
};

test("MCP reports native error names for inventory, discovery and calls without exposing error contents", async () => {
  const secret = "synthetic-upstream-secret";
  const fail = () =>
    Effect.fail(
      new ProviderUnavailable({
        name: secret,
        message: secret,
        upstreamBody: secret,
        cause: new Error(secret),
      }),
    );
  const code = "return await tools.fixture.hello({})";
  const inventory = await Effect.runPromise(
    execute({ ...backend, listApps: fail }, defaultMcpLimits, code),
  );
  assert.equal(inventory.execution.ok, false);
  if (!inventory.execution.ok)
    assert.equal(inventory.execution.error.message, "ProviderUnavailable");

  const discovery = await Effect.runPromise(
    execute({ ...backend, listTools: fail }, defaultMcpLimits, "return await tools.search({})"),
  );
  assert.equal(discovery.execution.ok, true);
  assert.deepEqual(discovery.unavailableApps, [
    { app, name: "Fixture", reason: "ProviderUnavailable" },
  ]);

  const call = await Effect.runPromise(
    execute({ ...backend, callTool: fail }, defaultMcpLimits, code),
  );
  assert.equal(call.execution.ok, false);
  if (!call.execution.ok) assert.equal(call.execution.error.message, "ProviderUnavailable");
  assert.equal(call.execution.toolCalls.length, 1);

  for (const result of [inventory, discovery, call])
    assert.ok(!JSON.stringify(result).includes(secret));
});
