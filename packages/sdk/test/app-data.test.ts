import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Real retained app code, SQLite transactions, and independent public SDK callers. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import {
  createExecutor,
  makeExecutorStorage,
  OwnerId,
  ToolName,
  ToolElicitationFailed,
} from "../src/index.ts";
import { nodeRuntime, filesystemAppDatabases } from "../src/node.ts";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";

const source = `import { query, mutation, array, defineApp, defineDatabase, table, object, string, number } from "apps";
const Message = object({ id: string(), subject: string(), tag: string() });
const database = defineDatabase({ messages: table({ subject: string(), score: number().optional(), tag: string().optional().default("inbox") }).index("by_score", ["score"]) });
export default defineApp({ accounts: {}, database }, async (appContext) => ({
    mutations: {
        inside: mutation({ input: object({}) }, async ({ db, elicit }) => { await db.messages.insert({ subject: "Must roll back" }); return elicit({ mode: "form", message: "Inside transaction", requestedSchema: { type: "object", properties: {} } }); }),
        captured: mutation({ input: object({}) }, async ({ db }) => { await db.messages.insert({ subject: "Captured callback must roll back" }); return appContext.elicit({ mode: "form", message: "Inside transaction", requestedSchema: { type: "object", properties: {} } }); }),
        guarded: mutation({ input: object({ subject: string() }), output: Message, approval: () => "user-approval" }, async ({ db }, value) => db.messages.insert(value)), ping: mutation({ description: "Ordinary external tool",
            input: object({}) }, async (operationContext, _input) => {
            return "pong";
        }), receive: mutation({ input: object({ subject: string() }), output: Message }, async ({ db }, value) => {
            const row = await db.messages.insert({ ...value, score: undefined, tag: null });
            await db.messages.update(row.id, { score: undefined });
            if (await db.messages.withIndex("by_score", q => q.eq("score", undefined)).count() !== 1)
                throw new Error("Optional index mismatch");
            return row;
        }), broken: mutation({ input: object({ subject: string() }), output: Message }, async ({ db }, value) => {
            await db.messages.insert(value);
            throw new Error("rollback this write");
        }), invalidOutput: mutation({ input: object({ subject: string() }), output: Message }, async ({ db }, value) => {
            await db.messages.insert(value);
            return { unexpected: "result" };
        }) },
    queries: {
        triesToWrite: query({ input: object({}), output: Message }, async ({ db }) => db.messages.insert({ subject: "forbidden" })),
        list: query({ description: "List saved inbox messages", input: object({}), output: array(Message) }, async ({ db }) => db.messages.withIndex("by_creation").collect()),
    },
}));
`;

test(
  "an app query updates after another caller commits; failed mutations roll back and copies remain isolated",
  { timeout: 20_000 },
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const credentialStore = yield* credentials(Redacted.make("ab".repeat(32)), crypto);
        const options = {
          blobs: memoryBlobStore(),
          sources: memorySourceStorage(),
          storage,
          credentials: credentialStore,
          appStorage: yield* filesystemAppDatabases({
            directory: `${directory}/data`,
            reactivity: storage.reactivity,
            crypto,
          }),
          runtime: nodeRuntime({ workDirectory: directory }),
        };
        yield* Effect.promise(async () => {
          const executor = await createExecutor(options);
          const writer = await createExecutor(options);
          const { app } = await executor.apps.deploy({
            owner: OwnerId.make("alice"),
            name: "Inbox",
            files: [{ path: "index.ts", content: source }],
          });
          const copy = await executor.apps.copy({
            from: app.id,
            owner: OwnerId.make("bob"),
            name: "Other inbox",
          });
          const discovered = await executor.tools.list({ app: app.id });
          assert.deepEqual(
            discovered.items.map((tool) => tool.name),
            [
              "mutations.broken",
              "mutations.captured",
              "mutations.guarded",
              "mutations.inside",
              "mutations.invalidOutput",
              "mutations.ping",
              "mutations.receive",
              "queries.list",
              "queries.triesToWrite",
            ],
          );
          const listed = discovered.items.find((tool) => tool.name === "queries.list");
          assert.equal(listed?.description, "List saved inbox messages");
          assert.equal(listed?.readOnly, true);
          assert.equal(listed?.annotations?.readOnlyHint, true);
          assert.ok(listed?.outputSchema);
          assert.equal(
            discovered.items.find((tool) => tool.name === "mutations.receive")?.readOnly,
            false,
          );
          assert.deepEqual(
            await writer.tools.call({
              app: app.id,
              tool: ToolName.make("mutations.ping"),
              input: {},
            }),
            { status: "completed", value: "pong" },
          );
          const input = { app: app.id, name: "list", input: {} };
          const iterator = (await executor.appData.subscribe(input))[Symbol.asyncIterator]();
          try {
            assert.deepEqual((await iterator.next()).value?.value, []);
            const updated = iterator.next();
            const result = await writer.tools.call({
              app: app.id,
              tool: ToolName.make("mutations.receive"),
              input: { subject: "New message" },
            });
            assert.equal(result.status, "completed");
            if (result.status !== "completed") throw new Error("Unexpected approval");
            const message = result.value;
            assert.deepEqual(
              await executor.tools.call({
                app: app.id,
                tool: ToolName.make("queries.list"),
                input: {},
              }),
              { status: "completed", value: [message] },
            );
            await assert.rejects(
              writer.tools.call({
                app: app.id,
                tool: ToolName.make("queries.triesToWrite"),
                input: {},
              }),
            );
            await assert.rejects(
              writer.tools.call({ app: app.id, tool: ToolName.make("queries.missing"), input: {} }),
            );
            await assert.rejects(
              writer.tools.call({
                app: app.id,
                tool: ToolName.make("mutations.broken"),
                input: { subject: "Rolled back agent write" },
              }),
            );
            await assert.rejects(
              writer.tools.call({
                app: app.id,
                tool: ToolName.make("mutations.invalidOutput"),
                input: { subject: "Invalid output agent write" },
              }),
            );
            await assert.rejects(
              writer.tools.call({
                app: app.id,
                tool: ToolName.make("mutations.receive"),
                input: { subject: 123 },
              }),
            );
            assert.deepEqual((await updated).value?.value, [message]);
            assert.deepEqual(await writer.appData.query({ ...input, app: copy.id }), []);
            assert.deepEqual(
              await writer.tools.call({
                app: copy.id,
                tool: ToolName.make("queries.list"),
                input: {},
              }),
              { status: "completed", value: [] },
            );
            await assert.rejects(
              writer.tools.call({
                app: app.id,
                tool: ToolName.make("queries.receive"),
                input: { subject: "wrong namespace" },
              }),
            );
            await assert.rejects(
              writer.appData.mutate({
                app: app.id,
                name: "broken",
                input: { id: "rolled-back", subject: "Failed" },
              }),
            );
            await assert.rejects(
              writer.appData.mutate({
                app: app.id,
                name: "invalidOutput",
                input: { id: "invalid-output", subject: "Failed" },
              }),
            );
            assert.deepEqual(await executor.appData.query(input), [message]);
            await assert.rejects(
              writer.appData.mutate({
                app: app.id,
                name: "guarded",
                input: { subject: "Must not write" },
              }),
            );
            const pending = await writer.tools.call({
              app: app.id,
              tool: ToolName.make("mutations.guarded"),
              input: { subject: "Approved" },
            });
            assert.equal(pending.status, "approval-required");
            if (pending.status !== "approval-required") throw new Error("Expected approval");
            assert.deepEqual(await executor.appData.query(input), [message]);
            const resumed = await writer.tools.resume({
              requestId: pending.requestId,
              response: { action: "accept" },
            });
            assert.equal(resumed.status, "completed");
            if (resumed.status !== "completed") throw new Error("Expected committed mutation");
            assert.deepEqual(await executor.appData.query(input), [message, resumed.value]);
            let delivered = 0;
            for (const name of ["inside", "captured"]) {
              await assert.rejects(
                writer.tools.call(
                  { app: app.id, tool: ToolName.make(`mutations.${name}`) },
                  {
                    elicitation: async () => {
                      delivered++;
                      return { action: "accept" as const, content: {} };
                    },
                  },
                ),
                (error: unknown) =>
                  Schema.is(ToolElicitationFailed)(error) && error.reason === "transaction",
              );
            }
            assert.equal(delivered, 0);
            assert.deepEqual(await executor.appData.query(input), [message, resumed.value]);
            // A deployment activation retains this configured app's storage.
            await writer.apps.deploy({
              owner: OwnerId.make("alice"),
              app: app.id,
              files: [{ path: "index.ts", content: source }],
            });
            assert.deepEqual(await executor.appData.query(input), [message, resumed.value]);
          } finally {
            await iterator.return?.();
          }
        });
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer())), Effect.scoped),
    );
  },
);
