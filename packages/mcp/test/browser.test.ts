/** Browser collection shares the execution manager's validation, expiry and consume-once lifecycle. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalRequestId,
  AppId,
  AppSlug,
  DeploymentId,
  OwnerId,
  ToolName,
  type ToolPending,
} from "@executor-js/sdk/core";
import { Clock, Effect, Fiber, Schema } from "effect";
import {
  makeExecutions,
  defaultMcpLimits,
  ElicitationResponseInvalid,
  type McpBackend,
} from "../src/index.ts";
const fixture = Effect.gen(function* () {
  const app = AppId.make("app_browser"),
    deployment = DeploymentId.make("dpl_browser"),
    tool = ToolName.make("guarded");
  const calls: string[] = [];
  let sequence = 0;
  const backend: McpBackend<Error> = {
    listSkills: () => Effect.die("Unexpected skill listing"),
    readSkill: () => Effect.die("Unexpected skill read"),
    listTargets: () => Effect.succeed([{ kind: "app" }]),
    listApps: () =>
      Effect.succeed([{ id: app, name: "Browser fixture", slug: AppSlug.make("browser-fixture") }]),
    listTools: () =>
      Effect.succeed({
        deployment,
        items: [
          { app, deployment, name: tool, description: "Guarded", inputSchema: { type: "object" } },
        ],
      }),
    authorizeElicitation: () => Effect.void,
    callTool: () =>
      Effect.gen(function* () {
        const pending: typeof ToolPending.Type = {
          status: "approval-required",
          requestId: ApprovalRequestId.make(`apr_browser_${++sequence}`),
          expiresAt: (yield* Clock.currentTimeMillis) + 900_000,
          invocation: {
            app,
            deployment,
            tool,
            owner: OwnerId.make("fixture"),
            input: {},
            accounts: {},
          },
          elicitation: {
            mode: "form",
            message: "Approve?",
            requestedSchema: { type: "object", properties: {} },
          },
        };
        return pending;
      }),
    resumeInvocation: (pending, response) =>
      Effect.sync(() => {
        calls.push(response.action);
        return response.action === "accept"
          ? { status: "completed" as const, value: "ran" }
          : {
              status: response.action === "decline" ? ("denied" as const) : ("cancelled" as const),
              requestId: pending.requestId,
            };
      }),
  };
  const engine = yield* makeExecutions(defaultMcpLimits);
  const pending = yield* engine.execute(
    "caller",
    backend,
    'return await tools["browser-fixture"].guarded({});',
  );
  if (pending.status !== "approval-required") throw new Error("Expected pending approval");
  return { engine, pending, backend, calls };
});

test("browser answers are scoped, validated, recorded once and executed only by resume", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, pending, backend, calls } = yield* fixture;
        assert.equal((yield* engine.browserView("other", pending.requestId)).status, "unavailable");
        assert.equal(
          (yield* engine.answerInBrowser("other", pending.requestId, { action: "accept" })).status,
          "unavailable",
        );
        assert.ok(
          Schema.is(ElicitationResponseInvalid)(
            yield* Effect.flip(
              engine.answerInBrowser("caller", pending.requestId, {
                action: "accept",
                content: { changed: true },
              }),
            ),
          ),
        );
        assert.equal((yield* engine.browserView("caller", pending.requestId)).status, "pending");
        const collector = yield* engine
          .browserAnswer("caller", pending.requestId, 5000)
          .pipe(Effect.forkChild);
        yield* engine.answerInBrowser("caller", pending.requestId, { action: "decline" });
        yield* engine.answerInBrowser("caller", pending.requestId, { action: "accept" });
        assert.deepEqual(calls, []);
        const response = yield* Fiber.join(collector);
        assert.deepEqual(response, { action: "decline" });
        assert.ok(response);
        assert.equal((yield* engine.browserView("caller", pending.requestId)).status, "answered");
        yield* engine.resume("caller", backend, { requestId: pending.requestId, response });
        assert.deepEqual(calls, ["decline"]);
        assert.equal(
          (yield* engine.browserView("caller", pending.requestId)).status,
          "unavailable",
        );
      }),
    ),
  ));

test("poll timeouts and cancelled collectors preserve a pause; discarding wakes collectors", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, pending } = yield* fixture;
        assert.equal(yield* engine.browserAnswer("caller", pending.requestId, 1), undefined);
        const first = yield* engine
          .browserAnswer("caller", pending.requestId, 5000)
          .pipe(Effect.forkChild);
        yield* Fiber.interrupt(first);
        assert.equal((yield* engine.browserView("caller", pending.requestId)).status, "pending");
        const next = yield* engine
          .browserAnswer("caller", pending.requestId, 5000)
          .pipe(Effect.forkChild);
        yield* engine.discard("caller", pending.requestId);
        assert.equal(yield* Fiber.join(next), undefined);
      }),
    ),
  ));
