import { memorySourceStorage } from "@executor-js/sdk/testing";
/** In-app workflow controls stay inside the invoking profile, including on approval resume. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkflowRunId } from "apps/contracts";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import {
  OwnerId,
  ToolName,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  type ExecutorOptions,
} from "@executor-js/sdk/core";
import { nodeRuntime, filesystemBlobStore } from "@executor-js/sdk/node";
import { storageSchema } from "../src/implementation/storage-schema.ts";

const owner = OwnerId.make("workflow-profile-owner");
const source = `import { mutation, workflow, defineApp, object, string } from "apps";
import { always } from "apps/operations/approval";
const job = workflow({ input: object({}) }, async () => "done");
export default defineApp({ accounts: {} }, {
  workflows: { job },
  mutations: {
    begin: mutation({ description: "Begin", input: object({}) }, async (ctx) =>
      ctx.workflows.start({ workflow: "job", input: {} })),
    inspect: mutation({ description: "Inspect", input: object({ run: string() }), approval: always() },
      async (ctx, input) => {
        const listed = (await ctx.workflows.list()).items.map((run) => run.id);
        const got = await ctx.workflows.get({ run: input.run }).then(() => "found", () => "hidden");
        const started = await ctx.workflows.start({ workflow: "job", input: {}, key: "resumed" });
        return { listed, got, started };
      }),
  },
});
`;
const services = Layer.mergeAll(NodeServices.layer, BrowserCrypto.layer, pgliteLayer());

test(
  "approval resume keeps workflow controls inside the resuming profile",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const options = {
            blobs: filesystemBlobStore({ directory: `${directory}/blobs` }),
            sources: memorySourceStorage(),
            storage,
            credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
            runtime: nodeRuntime({ workDirectory: directory }),
            workflows: {
              start: () => Effect.void,
              status: () => Effect.succeed({ status: "queued" as const }),
              terminate: () => Effect.void,
            },
          } satisfies ExecutorOptions;
          const executor = yield* createExecutor(options);
          const { app } = yield* executor.apps.deploy({
            owner,
            name: "Workflow profiles",
            files: [{ path: "index.ts", content: source }],
          });
          const profile = (subject: string) =>
            executor.apps.profiles.create({
              app: app.id,
              owner,
              subject,
              accounts: {},
              idempotencyKey: subject,
            });
          const a = yield* profile("user-a");
          const b = yield* profile("user-b");

          type Inspected = {
            listed: string[];
            got: string;
            started: { id: string; profile?: string; deployment: string };
          };
          const approved = (profileId: typeof a.id, run: string) =>
            Effect.gen(function* () {
              const pending = yield* executor.tools.call({
                app: app.id,
                profile: profileId,
                tool: ToolName.make("mutations.inspect"),
                input: { run },
              });
              assert.equal(pending.status, "approval-required");
              if (pending.status !== "approval-required") throw new Error("Expected approval");
              const resumed = yield* executor.tools.resume({
                requestId: pending.requestId,
                response: { action: "accept" },
                owner,
              });
              assert.equal(resumed.status, "completed");
              if (resumed.status !== "completed") throw new Error("Expected completion");
              return {
                value: resumed.value as Inspected,
                deployment: pending.invocation.deployment,
              };
            });

          const live = yield* executor.tools.call({
            app: app.id,
            profile: a.id,
            tool: ToolName.make("mutations.begin"),
            input: {},
          });
          assert.equal(live.status, "completed");
          if (live.status !== "completed") throw new Error("Expected run");
          const liveA = live.value as { id: string; profile?: string };
          assert.equal(liveA.profile, a.id);

          // A's resume starts a run; B's later resume must not see or reuse it.
          const first = yield* approved(a.id, liveA.id);
          assert.equal(first.value.got, "found");
          assert.equal(first.value.started.profile, a.id, "A's resumed run belongs to profile A");
          const runA = first.value.started.id;

          const second = yield* approved(b.id, runA);
          const value = second.value;
          assert.equal(value.got, "hidden", "B's resume cannot read A's run");
          assert.deepEqual(value.listed, [], "B's resume lists no runs before its own start");
          assert.notEqual(value.started.id, runA, "B's keyed start does not reuse A's run");
          assert.equal(value.started.profile, b.id, "B's resumed run belongs to profile B");
          assert.equal(value.started.deployment, second.deployment);
          const stored = yield* storage.orm(storageSchema.version).findFirst("workflowRuns", {
            where: (w) => w("id", "=", WorkflowRunId.make(value.started.id)),
          });
          assert.equal(stored?.profile, b.id);
          assert.equal(stored?.profileRevision, b.revision);
        }).pipe(Effect.provide(services)),
      ),
    ),
);
