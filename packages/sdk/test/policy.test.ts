import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Authored policies survive retained builds and return typed outcomes through both SDK surfaces. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { createExecutor as createPromiseExecutor } from "@executor-js/sdk";
import {
  InputInvalid,
  OwnerId,
  ToolBlocked,
  ToolName,
  ToolPolicyFailed,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { nodeRuntime } from "@executor-js/sdk/node";

const source = `import { withApproval, query, mutation, defineApp, number, object } from "apps";
import { always, never } from "apps/operations/approval";
let count = 0;
const write = mutation({ description: "Synthetic write", input: object({ amount: number().default(1) }), approval: ({ toolInput }) => toolInput.amount > 1 ? "user-approval" : "approved" }, async () => ++count);
export default defineApp({ accounts: {} }, async () => ({
    mutations: { write,
        blocked: withApproval(write, () => "denied"),
        broken: withApproval(write, () => { throw new Error("synthetic private policy detail"); }),
        confirm: withApproval(write, always()),
        count: mutation({ description: "Read count", input: object({}), approval: never() }, async () => count) },
}));
`;

test(
  "framework policy governs real Node execution without any createExecutor policy hook",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
          const options = {
            blobs: memoryBlobStore(),
            sources: memorySourceStorage(),
            storage,
            credentials,
            runtime: nodeRuntime({ workDirectory: directory }),
          };
          const executor = yield* createExecutor(options);
          const promise = yield* Effect.promise(() => createPromiseExecutor(options));
          const { app } = yield* executor.apps.deploy({
            owner: OwnerId.make("policy-owner"),
            name: "Policy example",
            files: [{ path: "index.ts", content: source }],
          });
          const list = yield* executor.tools.list({ app: app.id });
          assert.deepEqual(
            list.items.map(({ name }) => name),
            [
              "mutations.blocked",
              "mutations.broken",
              "mutations.confirm",
              "mutations.count",
              "mutations.write",
            ],
          );
          const call = (name: string, input = {}) =>
            executor.tools.call({ app: app.id, tool: ToolName.make(`mutations.${name}`), input });
          const blocked = yield* Effect.flip(call("blocked"));
          assert.ok(Schema.is(ToolBlocked)(blocked));
          assert.equal(blocked.app, app.id);
          assert.equal(blocked.deployment, app.activeDeployment);
          const pending = yield* call("write", { amount: 2 });
          assert.equal(pending.status, "approval-required");
          if (pending.status === "approval-required")
            assert.equal(pending.invocation.tool, "mutations.write");
          const failed = yield* Effect.flip(call("broken"));
          assert.ok(Schema.is(ToolPolicyFailed)(failed));
          assert.equal(JSON.stringify(failed).includes("synthetic private policy detail"), false);
          assert.ok(
            Schema.is(InputInvalid)(yield* Effect.flip(call("write", { amount: "wrong" }))),
          );
          assert.deepEqual(yield* call("count"), { status: "completed", value: 0 });
          assert.equal(
            (yield* Effect.promise(() =>
              promise.tools.call({
                app: app.id,
                tool: ToolName.make("mutations.write"),
                input: { amount: 2 },
              }),
            )).status,
            "approval-required",
          );
          assert.deepEqual(yield* call("count"), { status: "completed", value: 0 });
          assert.deepEqual(
            yield* Effect.promise(() =>
              promise.tools.call({
                app: app.id,
                tool: ToolName.make("mutations.write"),
                input: {},
              }),
            ),
            { status: "completed", value: 1 },
          );
          assert.deepEqual(yield* call("count"), { status: "completed", value: 1 });
        }).pipe(
          Effect.provide(Layer.mergeAll(BrowserCrypto.layer, NodeServices.layer, pgliteLayer())),
        ),
      ),
    ),
);
