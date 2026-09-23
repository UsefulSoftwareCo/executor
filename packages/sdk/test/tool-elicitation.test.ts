import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Live tool input through both SDK boundaries and real retained Node builds. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import {
  OwnerId,
  ToolElicitationFailed,
  ToolName,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { createExecutor as createPromiseExecutor } from "@executor-js/sdk";
import { nodeRuntime } from "@executor-js/sdk/node";
import { memoryBlobStore } from "@executor-js/sdk/blobs";

const source = `import { withApproval, query, mutation, defineApp, object } from "apps";
import { always } from "apps/operations/approval";
let starts = 0, finishes = 0;
const ask = mutation({ description: "Ask for a name", input: object({}) }, async ({ elicit }) => {
    const before = ++starts;
    const response = await elicit({ mode: "form", message: "Name this result", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
    if (response.action !== "accept")
        return { before, action: response.action };
    finishes++;
    return { before, answer: response.content.name };
});
export default defineApp({ accounts: {} }, async () => ({  mutations: { ask, guarded: withApproval(ask, always()), counts: mutation({ description: "Counts", input: object({}) }, async () => ({ starts, finishes })) } }));
`;
const services = Layer.mergeAll(NodeServices.layer, BrowserCrypto.layer, pgliteLayer());

test(
  "SDK passes invocation-owned elicitation through initial calls and approved resumes",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const options = {
            storage,
            blobs: memoryBlobStore(),
            sources: memorySourceStorage(),
            credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
            runtime: nodeRuntime({ workDirectory: directory }),
          };
          const executor = yield* createExecutor(options);
          const promise = yield* Effect.promise(() => createPromiseExecutor(options));
          const { app } = yield* executor.apps.deploy({
            owner: OwnerId.make("test"),
            name: "Live input",
            files: [{ path: "index.ts", content: source }],
          });
          const ask = { app: app.id, tool: ToolName.make("mutations.ask") };
          let delivered = 0;
          let signal: AbortSignal | undefined;
          const delivery: ToolInvocationOptions = {
            elicitation: (request, ownerSignal) =>
              Effect.sync(() => {
                assert.equal(request.message, "Name this result");
                signal = ownerSignal;
                delivered++;
                return { action: "accept", content: { name: "Ada" } };
              }),
          };
          assert.deepEqual(yield* executor.tools.call(ask, delivery), {
            status: "completed",
            value: { before: 1, answer: "Ada" },
          });
          assert.equal(signal?.aborted, true);
          const pending = yield* executor.tools.call(
            { ...ask, tool: ToolName.make("mutations.guarded") },
            delivery,
          );
          assert.equal(pending.status, "approval-required");
          assert.equal(delivered, 1, "policy confirmation does not run the tool");
          if (pending.status !== "approval-required") throw new Error("Expected confirmation");
          assert.deepEqual(
            yield* executor.tools.resume(
              { requestId: pending.requestId, response: { action: "accept" } },
              delivery,
            ),
            {
              status: "completed",
              value: { before: 2, answer: "Ada" },
            },
          );
          assert.equal(
            delivered,
            2,
            "approving the invocation does not auto-answer its own question",
          );
          assert.deepEqual(
            yield* Effect.promise(() =>
              promise.tools.call(ask, {
                elicitation: async (_request, ownerSignal) => {
                  assert.equal(ownerSignal.aborted, false);
                  return { action: "accept", content: { name: "Grace" } };
                },
              }),
            ),
            { status: "completed", value: { before: 3, answer: "Grace" } },
          );
          for (const action of ["decline", "cancel"] as const) {
            const result = yield* executor.tools.call(ask, {
              elicitation: () => Effect.succeed({ action }),
            });
            assert.equal(result.status, "completed");
            if (result.status === "completed")
              assert.ok(JSON.stringify(result.value).includes(action));
          }
          const unavailable = yield* Effect.flip(executor.tools.call(ask));
          assert.ok(Schema.is(ToolElicitationFailed)(unavailable));
          assert.equal(unavailable.reason, "unavailable");
          const invalid = yield* Effect.flip(
            executor.tools.call(ask, {
              elicitation: () => Effect.succeed({ action: "accept", content: { name: 42 } }),
            }),
          );
          assert.ok(Schema.is(ToolElicitationFailed)(invalid));
          assert.equal(invalid.reason, "invalid-response");
          assert.deepEqual(
            yield* executor.tools.call({ ...ask, tool: ToolName.make("mutations.counts") }),
            {
              status: "completed",
              value: { starts: 7, finishes: 3 },
            },
          );
        }),
      ).pipe(Effect.provide(services)),
    ),
);
