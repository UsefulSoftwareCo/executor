/** Tool-owned approvals exercised without Executor through the portable handler. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withApproval, mutation, defineApp, number, object, type Operation } from "apps";
import {
  always,
  never,
  type Approval,
  type ApprovalContext,
  type ApprovalDecision,
} from "apps/operations/approval";
import {
  HostInputInvalid,
  HostRequestInvalid,
  HostResponse,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
} from "apps/contracts";
import { createAppHandler, hostContext } from "apps/host";
import { openapiOperations } from "apps/openapi";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import { Deferred, Effect, Schema } from "effect";

async function dispatch(
  handler: ReturnType<typeof createAppHandler>,
  command: unknown,
  signal?: AbortSignal,
) {
  const response = await handler(
    new Request("https://synthetic.test/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
      ...(signal === undefined ? {} : { signal }),
    }),
    hostContext({}),
  );
  return {
    status: response.status,
    body: Schema.decodeUnknownSync(HostResponse)(await response.json()),
  };
}

test("only the selected tool's approval runs, with decoded input; shared functions are reusable", async () => {
  const reviewed: ApprovalContext<{ readonly amount: number }>[] = [];
  const executed: string[] = [];
  const input = object({ amount: number().default(5) });
  const shared: Approval<{ readonly amount: number }> = (call) => {
    reviewed.push(call);
    return call.toolInput.amount > 5 ? "user-approval" : "approved";
  };
  const make = (
    name: string,
    approval?: Approval<{ readonly amount: number }>,
  ): Operation<{ readonly amount: number }, unknown, "mutation"> =>
    mutation(
      { description: name, input, ...(approval === undefined ? {} : { approval }) },
      async (_context, value) => {
        executed.push(name);
        return value;
      },
    );
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async () => ({
      mutations: {
        read: make("read", never()),
        write: make("write", always()),
        destroy: make("destroy", () => "denied"),
        custom: make("custom", shared),
        other: make("other", shared),
        ordinary: make("ordinary"),
      },
    })),
  );
  assert.deepEqual(
    (await dispatch(handler, { operation: "call", tool: "mutations.read", input: {} })).body,
    {
      ok: true,
      value: { amount: 5 },
    },
  );
  assert.equal(reviewed.length, 0);
  const pending = await dispatch(handler, {
    operation: "call",
    tool: "mutations.write",
    input: {},
  });
  assert.equal(pending.status, 409);
  assert.ok(!pending.body.ok && Schema.is(HostToolApprovalRequired)(pending.body.error));
  const blocked = await dispatch(handler, {
    operation: "call",
    tool: "mutations.destroy",
    input: {},
  });
  assert.equal(blocked.status, 403);
  assert.ok(!blocked.body.ok && Schema.is(HostToolBlocked)(blocked.body.error));
  assert.equal(
    (await dispatch(handler, { operation: "call", tool: "mutations.custom", input: {} })).body.ok,
    true,
  );
  assert.equal(
    (await dispatch(handler, { operation: "call", tool: "mutations.other", input: { amount: 6 } }))
      .status,
    409,
  );
  assert.equal(
    (await dispatch(handler, { operation: "call", tool: "mutations.ordinary", input: {} })).body.ok,
    true,
  );
  assert.deepEqual(executed, ["read", "custom", "ordinary"]);
  assert.deepEqual(
    reviewed.map(({ toolName, toolInput }) => ({ toolName, toolInput })),
    [
      { toolName: "mutations.custom", toolInput: { amount: 5 } },
      { toolName: "mutations.other", toolInput: { amount: 6 } },
    ],
  );
  assert.ok(reviewed.every(({ signal }) => signal instanceof AbortSignal));
  const catalog = await dispatch(handler, { operation: "inspect" });
  assert.equal(catalog.body.ok, true);
  assert.equal(JSON.stringify(catalog.body).includes("approval"), false);
  assert.equal(reviewed.length, 2);
});

test("invalid and unknown calls never reach approval; request JSON cannot approve itself", async () => {
  let evaluations = 0;
  let executions = 0;
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async (_appContext) => ({
      mutations: {
        write: mutation(
          {
            description: "Write",
            input: object({ amount: number() }),
            approval: () => {
              evaluations++;
              return "user-approval";
            },
          },
          async (_operationContext, _input) => {
            executions++;
            return null;
          },
        ),
      },
    })),
  );
  const invalid = await dispatch(handler, {
    operation: "call",
    tool: "mutations.write",
    input: { amount: "wrong" },
  });
  assert.ok(!invalid.body.ok && Schema.is(HostInputInvalid)(invalid.body.error));
  const missing = await dispatch(handler, {
    operation: "call",
    tool: "mutations.absent",
    input: {},
  });
  assert.ok(!missing.body.ok && Schema.is(HostToolNotFound)(missing.body.error));
  const spoofed = await dispatch(handler, {
    operation: "call",
    tool: "mutations.write",
    input: { amount: 1 },
    approved: true,
  });
  assert.ok(!spoofed.body.ok && Schema.is(HostRequestInvalid)(spoofed.body.error));
  assert.equal(evaluations, 0);
  assert.equal(executions, 0);
});

test("typed async approval sees this tool's input and runs for every call", async () => {
  let limit = 10;
  let executed = 0;
  const input = object({ amount: number() });
  const write: Operation<{ readonly amount: number }, unknown, "mutation"> = mutation(
    {
      description: "Write",
      input,
      approval: async ({ toolInput }) => (toolInput.amount <= limit ? "approved" : "user-approval"),
    },
    async () => ++executed,
  );
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async () => ({ mutations: { write } })),
  );
  assert.deepEqual(
    (await dispatch(handler, { operation: "call", tool: "mutations.write", input: { amount: 5 } }))
      .body,
    { ok: true, value: 1 },
  );
  limit = 1;
  const changed = await dispatch(handler, {
    operation: "call",
    tool: "mutations.write",
    input: { amount: 5 },
  });
  assert.ok(!changed.body.ok && Schema.is(HostToolApprovalRequired)(changed.body.error));
  assert.equal(executed, 1);
});

for (const approval of [
  () => {
    throw new Error("private policy data");
  },
  async () => {
    throw new Error("private policy data");
  },
  () => "unexpected",
  () => undefined,
  () => ({ action: "approved" }),
  null,
]) {
  test("malformed or failed tool approval prevents execution without exposing the failure", async () => {
    let executions = 0;
    const handler = createAppHandler(
      defineApp({ accounts: {} }, async () => {
        const options = { input: object({}) };
        Object.defineProperty(options, "approval", { value: approval, enumerable: true });
        return {
          mutations: {
            write: mutation(options, async () => {
              executions++;
              return null;
            }),
          },
        };
      }),
    );
    const result = await dispatch(handler, {
      operation: "call",
      tool: "mutations.write",
      input: {},
    });
    assert.equal(result.status, 500);
    assert.ok(!result.body.ok && Schema.is(HostToolPolicyFailed)(result.body.error));
    assert.equal(JSON.stringify(result).includes("private policy data"), false);
    assert.equal(executions, 0);
  });
}

test("generated OpenAPI tools receive approval when composing the catalog", async () => {
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async ({ signal }) => {
      const generated = await openapiOperations({
        signal,
        methods: {},
        oauth: [],
        operations: [
          {
            name: "deleteItem",
            description: "Delete an item",
            method: "DELETE",
            path: "/items/one",
            baseUrl: "https://synthetic.test",
            parameters: [],
            body: "none",
            security: [],
            input: { type: "object", properties: {} },
          },
        ],
      });
      return {
        mutations: Object.fromEntries(
          Object.entries(generated.mutations).map(([name, operation]) => [
            name,
            withApproval(operation, always()),
          ]),
        ),
      };
    }),
  );
  const result = await dispatch(handler, {
    operation: "call",
    tool: "mutations.deleteItem",
    input: {},
  });
  assert.ok(!result.body.ok && Schema.is(HostToolApprovalRequired)(result.body.error));
});

test("cancelling a waiting tool approval aborts it and prevents the tool body", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const controller = new AbortController();
  let executions = 0;
  const approval: Approval = async ({ signal }): Promise<ApprovalDecision> => {
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await Effect.runPromise(Deferred.succeed(entered, undefined));
    await aborted;
    return "approved";
  };
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async (_appContext) => ({
      mutations: {
        write: mutation(
          { description: "Write", input: object({}), approval },
          async (_operationContext, _input) => {
            executions++;
            return null;
          },
        ),
      },
    })),
  );
  const running = dispatch(
    handler,
    { operation: "call", tool: "mutations.write", input: {} },
    controller.signal,
  );
  const rejected = assert.rejects(running);
  await Effect.runPromise(Deferred.await(entered));
  controller.abort();
  await rejected;
  assert.equal(executions, 0);
});

test("trusted resume matches decoded arguments and tool identity without asking approval twice", async () => {
  let decisions = 0;
  let executions = 0;
  const input = object({ amount: number().default(5) });
  const guarded = mutation(
    {
      description: "Guarded",
      input,
      approval: (): ApprovalDecision => {
        decisions++;
        return "user-approval";
      },
    },
    async () => ++executions,
  );
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async () => ({
      mutations: { write: guarded, other: guarded },
    })),
  );
  const pending = await dispatch(handler, {
    operation: "call",
    tool: "mutations.write",
    input: {},
  });
  assert.ok(!pending.body.ok && Schema.is(HostToolApprovalRequired)(pending.body.error));
  assert.deepEqual(pending.body.error.input, { amount: 5 });
  const elicitation = Schema.decodeUnknownSync(McpSchema.ElicitRequestFormParams)(
    pending.body.error.elicitation,
  );
  assert.equal(elicitation.mode, "form");
  assert.deepEqual(elicitation.requestedSchema, { type: "object", properties: {} });
  assert.match(elicitation.message, /Approve mutations\.write/);
  assert.match(elicitation.message, /"amount": 5/);

  const context = hostContext({}, { tool: "mutations.write", input: pending.body.error.input });
  const resume = async (tool: string, input: unknown) => {
    const response = await handler(
      new Request("https://synthetic.test/dispatch", {
        method: "POST",
        body: JSON.stringify({ operation: "call", tool, input }),
      }),
      context,
    );
    return Schema.decodeUnknownSync(HostResponse)(await response.json());
  };
  const differentTool = await resume("mutations.other", {});
  assert.ok(!differentTool.ok && Schema.is(HostInputInvalid)(differentTool.error));
  const differentInput = await resume("mutations.write", { amount: 6 });
  assert.ok(!differentInput.ok && Schema.is(HostInputInvalid)(differentInput.error));
  assert.equal(executions, 0);
  assert.deepEqual(await resume("mutations.write", {}), { ok: true, value: 1 });
  assert.equal(decisions, 1);
});
