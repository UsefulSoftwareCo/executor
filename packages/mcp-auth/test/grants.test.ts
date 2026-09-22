import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import {
  AppId,
  AppSlug,
  ToolName,
  DeploymentId,
  ApprovalRequestId,
  OwnerId,
} from "@executor-js/sdk/core";
import type { McpBackend } from "@executor-js/mcp";
import {
  Grant,
  GrantId,
  GrantPolicy,
  permitsDelivery,
  requestedMcpMode,
  mcpResource,
  grantTarget,
  permitsTool,
  restrictMcpBackend,
} from "../src/index.ts";

const app = AppId.make("app_example"),
  management = AppId.make("app_management");
const target = { kind: "mcp", mode: "browser" } as const;
const read = ToolName.make("read"),
  write = ToolName.make("write");
const policy = {
  kind: "tools",
  apps: [{ app, tools: { kind: "selected", names: [read] } }],
  approval: "browser",
} satisfies GrantPolicy;

test("exact selections, future tools, and approval authority stay separate", () => {
  assert.equal(permitsTool(policy, app, read), true);
  assert.equal(permitsTool(policy, app, write), false);
  assert.equal(permitsTool(policy, management, read), false);
  assert.equal(
    permitsDelivery({ id: GrantId.make("grant_fixture"), policy, target }, "model"),
    false,
  );
  assert.equal(
    permitsDelivery({ id: GrantId.make("grant_fixture"), policy, target }, "native"),
    false,
  );
  assert.equal(
    permitsDelivery({ id: GrantId.make("grant_fixture"), policy, target }, "browser"),
    true,
  );
  assert.equal(
    permitsTool({ ...policy, apps: [{ app, tools: { kind: "all" } }] }, app, write),
    true,
  );
  assert.equal(permitsTool({ ...policy, apps: [] }, app, read), false);
  assert.throws(() => Schema.decodeUnknownSync(GrantPolicy)({ kind: "tools", apps: [] }));
});

test("undiscovered calls and resume recheck the live grant before side effects", async () => {
  let current = Grant.make({ id: GrantId.make("grant_fixture"), policy, target });
  let calls = 0;
  const backend: McpBackend<Error> = {
    listSkills: () => Effect.die("Unexpected skill listing"),
    readSkill: () => Effect.die("Unexpected skill read"),
    listTargets: () => Effect.succeed([{ kind: "app" }]),
    listApps: (input) =>
      Effect.sync(() => {
        assert.deepEqual(
          input?.ids,
          [app],
          "the allowed app IDs must reach the host before loading apps",
        );
        return [{ id: app, name: "Example", slug: AppSlug.make("example") }];
      }),
    listTools: () => Effect.succeed({ deployment: DeploymentId.make("dpl_fixture"), items: [] }),
    callTool: () => Effect.sync(() => ({ status: "completed" as const, value: ++calls })),
    resumeInvocation: () => Effect.sync(() => ({ status: "completed" as const, value: ++calls })),
    authorizeElicitation: () => Effect.void,
  };
  const restricted = restrictMcpBackend(
    backend,
    Effect.sync(() => current),
  );
  assert.deepEqual(await Effect.runPromise(restricted.listApps()), [
    { id: app, name: "Example", slug: AppSlug.make("example") },
  ]);
  await assert.rejects(Effect.runPromise(restricted.callTool({ app, tool: write })));
  assert.equal(calls, 0);
  await Effect.runPromise(restricted.callTool({ app, tool: read }));
  assert.equal(calls, 1);
  current = { ...current, policy: { ...policy, apps: [] } };
  await assert.rejects(Effect.runPromise(restricted.authorizeElicitation({ app, tool: read })));
  await assert.rejects(
    Effect.runPromise(
      restricted.resumeInvocation(
        {
          status: "approval-required",
          requestId: ApprovalRequestId.make("apr_fixture"),
          invocation: {
            app,
            deployment: DeploymentId.make("dpl_fixture"),
            tool: read,
            input: {},
            owner: OwnerId.make("fixture"),
            accounts: {},
          },
          elicitation: {
            mode: "form",
            message: "Approve",
            requestedSchema: { type: "object", properties: {} },
          },
          expiresAt: Date.now() + 60_000,
        },
        { action: "accept" },
      ),
    ),
  );
  assert.equal(calls, 1);
});

test("discovery intersects caller IDs with current grants before reaching the host", async () => {
  let current = Grant.make({ id: GrantId.make("grant_fixture"), policy, target });
  const requested: Array<readonly AppId[] | undefined> = [];
  const backend: McpBackend<Error> = {
    listSkills: () => Effect.die("Unexpected skill listing"),
    readSkill: () => Effect.die("Unexpected skill read"),
    listTargets: () => Effect.succeed([{ kind: "app" }]),
    listApps: (input) =>
      Effect.sync(() => {
        requested.push(input?.ids);
        return [];
      }),
    listTools: () => Effect.succeed({ deployment: DeploymentId.make("dpl_fixture"), items: [] }),
    callTool: () => Effect.die("Unexpected call"),
    resumeInvocation: () => Effect.die("Unexpected resume"),
    authorizeElicitation: () => Effect.void,
  };
  const scoped = restrictMcpBackend(
    backend,
    Effect.sync(() => current),
  );
  await Effect.runPromise(scoped.listApps({ ids: [management] }));
  await Effect.runPromise(scoped.listApps({ ids: [] }));
  current = {
    ...current,
    policy: {
      kind: "tools",
      approval: "browser",
      apps: [
        { app, tools: { kind: "selected", names: [] } },
        { app: management, tools: { kind: "all" } },
      ],
    },
  };
  await Effect.runPromise(scoped.listApps());
  current = { ...current, policy: { ...policy, apps: [...policy.apps, ...policy.apps] } };
  await Effect.runPromise(scoped.listApps({ ids: [app, management] }));
  current = { ...current, policy: { kind: "all" } };
  await Effect.runPromise(scoped.listApps());
  await Effect.runPromise(scoped.listApps({ ids: [] }));
  await Effect.runPromise(scoped.listApps({ ids: [management] }));
  assert.deepEqual(requested, [[], [], [management], [app], undefined, [], [management]]);
});

test("OAuth resources bind one URL mode including full-access connections", () => {
  const origin = "https://example.test";
  for (const mode of ["model", "native", "browser"] as const) {
    const resource = mcpResource(origin, mode);
    const target = grantTarget(origin, [resource]);
    assert.deepEqual(target, { kind: "mcp", mode });
    assert.ok(target);
    const grant = Grant.make({ id: GrantId.make("grant_modes"), policy: { kind: "all" }, target });
    for (const requested of ["model", "native", "browser"] as const)
      assert.equal(permitsDelivery(grant, requested), mode === requested);
  }
  assert.equal(
    grantTarget(origin, [mcpResource(origin, "browser"), mcpResource(origin, "model")]),
    undefined,
  );
  assert.equal(grantTarget(origin, []), undefined);
  assert.equal(requestedMcpMode(new URL(origin + "/mcp")), "model");
  assert.equal(requestedMcpMode(new URL(origin + "/mcp?elicitation_mode=nope")), undefined);
  assert.equal(
    requestedMcpMode(new URL(origin + "/mcp?elicitation_mode=native&elicitation_mode=model")),
    undefined,
  );
});
