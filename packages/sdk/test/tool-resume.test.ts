import { memorySourceStorage } from "@executor-js/sdk/testing";
/** SDK approval lifecycle over real migrated SQL and a retained Node app. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, Redacted, Schema } from "effect";
import {
  ApprovalRequestId,
  OwnerId,
  RequestInvalid,
  ToolApprovalNotFound,
  ToolName,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
  toEffectRuntime,
  type ExecutorOptions,
} from "@executor-js/sdk/core";
import { createExecutor as createPromiseExecutor } from "@executor-js/sdk";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import { nodeRuntime, filesystemBlobStore } from "@executor-js/sdk/node";

const owner = OwnerId.make("approval-owner");
const tool = ToolName.make("mutations.write");
const source = (
  version: string,
) => `import { query, mutation, defineApp, defineProvider, secrets, object, string, number } from "apps";
import { always } from "apps/operations/approval";
const service = defineProvider({ name: "Synthetic", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
let calls = 0;
export default defineApp({ accounts: { service } }, async (appContext) => ({
     mutations: { write: mutation({ description: "Write",
            input: object({ amount: number().default(7), message: string().default("synthetic message") }),
            approval: always() }, async (operationContext, input) => {
            const { accounts } = { ...appContext, ...operationContext };
            return ({ version: "${version}", count: ++calls, token: accounts.service.fields.token, input });
        }),
        fail: mutation({ description: "Fail after starting",
            input: object({}),
            approval: always() }, async (operationContext, _input) => {
            calls++;
            throw new Error("private tool failure");
        }),
        count: mutation({ description: "Count",
            input: object({}) }, async (operationContext, _input) => {
            return calls;
        }) },
}));
`;
const makeOptions = (directory: string) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
    return {
      blobs: filesystemBlobStore({ directory: `${directory}/blobs` }),
      sources: memorySourceStorage(),
      storage,
      credentials,
      runtime: nodeRuntime({ workDirectory: directory }),
    } satisfies ExecutorOptions;
  });
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const options = yield* makeOptions(directory);
  const executor = yield* createExecutor(options);
  const { app } = yield* executor.apps.deploy({
    owner,
    name: "Approval fixture",
    files: [{ path: "index.ts", content: source("first") }],
  });
  const slot = app.requirements.accounts.service;
  assert.ok(slot);
  const account = yield* executor.accounts.add({
    owner,
    provider: slot.provider,
    method: "key",
    label: "First",
    fields: Redacted.make({ token: "synthetic-secret" }),
  });
  yield* executor.apps.update({ app: app.id, accounts: { service: account.id } });
  return { options, executor, app, account };
});
const services = Layer.mergeAll(NodeServices.layer, BrowserCrypto.layer, pgliteLayer());

const pending = (f: Effect.Success<typeof fixture>, name = "write") =>
  f.executor.tools
    .call({ app: f.app.id, tool: ToolName.make(`mutations.${name}`), input: {} })
    .pipe(
      Effect.map((result) => {
        assert.equal(result.status, "approval-required");
        if (result.status !== "approval-required") throw new Error("Expected approval");
        return result;
      }),
    );

test(
  "approve resumes saved code and decoded arguments with current credentials; payload is discarded and repeats are consumed",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          assert.deepEqual(request.invocation.input, { amount: 7, message: "synthetic message" });
          const form = Schema.decodeUnknownSync(McpSchema.ElicitRequestFormParams)(
            request.elicitation,
          );
          assert.equal(form.mode, "form");
          assert.deepEqual(form.requestedSchema, { type: "object", properties: {} });
          assert.ok(form.message.includes(JSON.stringify(request.invocation.input, null, 2)));

          assert.equal(JSON.stringify(request).includes("synthetic-secret"), false);
          assert.deepEqual(
            yield* f.executor.tools.call({ app: f.app.id, tool: ToolName.make("mutations.count") }),
            { status: "completed", value: 0 },
          );
          const rows = yield* f.options.storage.orm("3.0.0").findMany("toolApprovals", {});
          assert.equal(rows.length, 1);
          assert.ok(rows[0]);
          assert.equal(
            new TextDecoder().decode(rows[0].encrypted).includes("synthetic message"),
            false,
          );
          yield* f.executor.apps.deploy({
            owner,
            app: f.app.id,
            files: [{ path: "index.ts", content: source("second") }],
          });
          yield* f.executor.accounts.replaceCredentials({
            account: f.account.id,
            fields: Redacted.make({ token: "rotated-synthetic-secret" }),
          });
          const second = yield* createExecutor(f.options);
          const result = yield* second.tools.resume({
            requestId: request.requestId,
            response: { action: "accept" },
            owner,
          });
          assert.deepEqual(result, {
            status: "completed",
            value: {
              version: "first",
              count: 1,
              token: "rotated-synthetic-secret",
              input: request.invocation.input,
            },
          });
          const marker = yield* f.options.storage
            .orm("3.0.0")
            .findFirst("toolApprovals", { where: (b) => b("id", "=", request.requestId) });
          assert.ok(marker);
          assert.equal(marker.status, "consumed");
          assert.equal(marker.encrypted.byteLength, 0, "No arguments or tool output remain stored");
          // A later decision cannot repeat execution or retrieve the previous result.
          assert.deepEqual(
            yield* f.executor.tools.resume({
              requestId: request.requestId,
              response: { action: "decline" },
            }),
            { status: "already-consumed", requestId: request.requestId },
          );
          const promise = yield* Effect.promise(() => createPromiseExecutor(f.options));
          assert.deepEqual(
            yield* Effect.promise(() =>
              promise.tools.resume({
                requestId: request.requestId,
                response: { action: "accept" },
              }),
            ),
            { status: "already-consumed", requestId: request.requestId },
          );
          assert.deepEqual(
            yield* f.executor.tools.call({
              app: f.app.id,
              deployment: request.invocation.deployment,
              tool: ToolName.make("mutations.count"),
            }),
            { status: "completed", value: 1 },
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "deny clears the payload and expiry deletes the request; unknown and foreign IDs fail",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          const denied = yield* f.executor.tools.resume({
            requestId: request.requestId,
            response: { action: "decline" },
          });
          assert.deepEqual(denied, { status: "denied", requestId: request.requestId });
          const marker = yield* f.options.storage
            .orm("3.0.0")
            .findFirst("toolApprovals", { where: (b) => b("id", "=", request.requestId) });
          assert.ok(marker);
          assert.equal(marker.encrypted.byteLength, 0);
          assert.deepEqual(
            yield* f.executor.tools.resume({
              requestId: request.requestId,
              response: { action: "accept" },
            }),
            { status: "already-consumed", requestId: request.requestId },
          );
          assert.ok(
            Schema.is(ToolApprovalNotFound)(
              yield* Effect.flip(
                f.executor.tools.resume({
                  requestId: request.requestId,
                  owner: OwnerId.make("foreign"),
                  response: { action: "accept" },
                }),
              ),
            ),
          );
          assert.ok(
            Schema.is(ToolApprovalNotFound)(
              yield* Effect.flip(
                f.executor.tools.resume({
                  requestId: ApprovalRequestId.make("apr_missing"),
                  response: { action: "accept" },
                }),
              ),
            ),
          );
          const expired = yield* pending(f);
          const clock = yield* Clock.Clock;
          const now = expired.expiresAt + 1;
          const outcome = yield* f.executor.tools
            .resume({ requestId: expired.requestId, response: { action: "accept" } })
            .pipe(
              Effect.provideService(Clock.Clock, {
                currentTimeMillis: Effect.succeed(now),
                currentTimeMillisUnsafe: () => now,
                currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
                currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
                monotonicTimeNanos: clock.monotonicTimeNanos,
                monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                sleep: (duration) => clock.sleep(duration),
              }),
            );
          assert.deepEqual(outcome, {
            status: "failed",
            requestId: expired.requestId,
            reason: "expired",
          });
          assert.equal(
            yield* f.options.storage
              .orm("3.0.0")
              .findFirst("toolApprovals", { where: (b) => b("id", "=", expired.requestId) }),
            null,
          );
          assert.deepEqual(
            yield* f.executor.tools.call({ app: f.app.id, tool: ToolName.make("mutations.count") }),
            { status: "completed", value: 0 },
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

for (const change of ["selection", "account-removed", "app-removed"] as const) {
  test(`resume rejects ${change} without running`, { timeout: 20_000 }, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          if (change === "selection") {
            const other = yield* f.executor.accounts.add({
              owner,
              provider: f.account.provider,
              method: "key",
              label: "Other",
              fields: Redacted.make({ token: "other" }),
            });
            yield* f.executor.apps.update({ app: f.app.id, accounts: { service: other.id } });
          } else if (change === "account-removed")
            yield* f.executor.accounts.remove({ account: f.account.id });
          else yield* f.executor.apps.remove({ app: f.app.id });
          const result = yield* f.executor.tools.resume({
            requestId: request.requestId,
            response: { action: "accept" },
          });
          assert.deepEqual(result, {
            status: "failed",
            requestId: request.requestId,
            reason: "context-changed",
          });
          assert.deepEqual(
            yield* f.executor.tools.resume({
              requestId: request.requestId,
              response: { action: "accept" },
            }),
            { status: "already-consumed", requestId: request.requestId },
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
  );
}

test("concurrent resumes from independent SDK handles dispatch once", { timeout: 20_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* pending(f);
        const native = toEffectRuntime(f.options.runtime, f.options.blobs);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let dispatches = 0;
        const runtime = runtimeAdapter({
          ...native,
          call: (input) =>
            Effect.gen(function* () {
              dispatches++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* native.call(input);
            }),
        });
        const a = yield* createExecutor({ ...f.options, runtime });
        const b = yield* createExecutor({ ...f.options, runtime });
        const first = yield* a.tools
          .resume({ requestId: request.requestId, response: { action: "accept" } })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const marker = yield* f.options.storage
          .orm("3.0.0")
          .findFirst("toolApprovals", { where: (b) => b("id", "=", request.requestId) });
        assert.ok(marker);
        assert.equal(marker.status, "consumed");
        assert.equal(
          marker.encrypted.byteLength,
          0,
          "Arguments must be cleared before the runtime starts",
        );
        const competing = yield* Effect.all(
          Array.from({ length: 6 }, () =>
            b.tools.resume({ requestId: request.requestId, response: { action: "accept" } }),
          ),
          { concurrency: 6 },
        );
        assert.ok(competing.every((result) => result.status === "already-consumed"));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(first);
        assert.equal(result.status, "completed");
        assert.equal(dispatches, 1);
        assert.deepEqual(
          yield* b.tools.resume({ requestId: request.requestId, response: { action: "accept" } }),
          { status: "already-consumed", requestId: request.requestId },
        );
        assert.equal(dispatches, 1);
      }).pipe(Effect.provide(services)),
    ),
  ),
);

test(
  "tool failures and interrupted dispatches remain consumed without storing their outcomes",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const failedRequest = yield* pending(f, "fail");
          const failed = yield* f.executor.tools.resume({
            requestId: failedRequest.requestId,
            response: { action: "accept" },
          });
          assert.deepEqual(failed, {
            status: "failed",
            requestId: failedRequest.requestId,
            reason: "execution-failed",
          });
          assert.deepEqual(
            yield* f.executor.tools.resume({
              requestId: failedRequest.requestId,
              response: { action: "accept" },
            }),
            { status: "already-consumed", requestId: failedRequest.requestId },
          );
          assert.deepEqual(
            yield* f.executor.tools.call({ app: f.app.id, tool: ToolName.make("mutations.count") }),
            { status: "completed", value: 1 },
          );
          const request = yield* pending(f);
          const started = yield* Deferred.make<void>();
          let dispatches = 0;
          const executor = yield* createExecutor({
            ...f.options,
            runtime: runtimeAdapter({
              ...toEffectRuntime(f.options.runtime, f.options.blobs),
              call: () =>
                Effect.sync(() => {
                  dispatches++;
                }).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Effect.never),
                ),
            }),
          });
          const running = yield* executor.tools
            .resume({ requestId: request.requestId, response: { action: "accept" } })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(running);
          assert.deepEqual(
            yield* executor.tools.resume({
              requestId: request.requestId,
              response: { action: "accept" },
            }),
            { status: "already-consumed", requestId: request.requestId },
          );
          assert.equal(dispatches, 1);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "resume accepts no replacement arguments even from an untyped caller",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          const decision = {
            requestId: request.requestId,
            response: { action: "accept" as const },
            input: { amount: 999 },
          };
          assert.ok(
            Schema.is(RequestInvalid)(yield* Effect.flip(f.executor.tools.resume(decision))),
          );
          const promise = yield* Effect.promise(() => createPromiseExecutor(f.options));
          yield* Effect.promise(() =>
            assert.rejects(promise.tools.resume(decision), Schema.is(RequestInvalid)),
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "pending calls and consumed markers survive closing and reopening disk storage",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const open = <A, E, R>(work: (options: ExecutorOptions) => Effect.Effect<A, E, R>) =>
            Effect.scoped(
              makeOptions(`${directory}/builds`).pipe(
                Effect.flatMap(work),
                Effect.provide(pgliteLayer({ dataDir: `${directory}/db` })),
              ),
            );
          const request = yield* open((options) =>
            Effect.gen(function* () {
              const executor = yield* createExecutor(options);
              const { app } = yield* executor.apps.deploy({
                owner,
                name: "Restart",
                files: [{ path: "index.ts", content: source("restart") }],
              });
              const slot = app.requirements.accounts.service;
              assert.ok(slot);
              const account = yield* executor.accounts.add({
                owner,
                provider: slot.provider,
                method: "key",
                label: "First",
                fields: Redacted.make({ token: "synthetic" }),
              });
              yield* executor.apps.update({ app: app.id, accounts: { service: account.id } });
              const result = yield* executor.tools.call({ app: app.id, tool });
              assert.equal(result.status, "approval-required");
              if (result.status !== "approval-required") throw new Error("Expected approval");
              return result;
            }),
          );
          const run = () =>
            open((options) =>
              createExecutor(options).pipe(
                Effect.flatMap((sdk) =>
                  sdk.tools.resume({
                    requestId: request.requestId,
                    response: { action: "accept" },
                  }),
                ),
              ),
            );
          const completed = yield* run();
          assert.equal(completed.status, "completed");
          assert.deepEqual(yield* run(), {
            status: "already-consumed",
            requestId: request.requestId,
          });
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, BrowserCrypto.layer))),
      ),
    ),
);

test(
  "caller transactions cannot roll back an execution claim after a side effect",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          const db = f.options.storage.orm("3.0.0");
          assert.ok(
            Schema.is(RequestInvalid)(
              yield* Effect.flip(
                db.transaction(
                  f.executor.tools.resume({
                    requestId: request.requestId,
                    response: { action: "accept" },
                  }),
                ),
              ),
            ),
          );
          assert.ok(
            Schema.is(RequestInvalid)(
              yield* Effect.flip(db.transaction(f.executor.tools.call({ app: f.app.id, tool }))),
            ),
          );
          const result = yield* f.executor.tools.resume({
            requestId: request.requestId,
            response: { action: "accept" },
          });
          assert.equal(result.status, "completed");
          assert.deepEqual(
            yield* f.executor.tools.call({ app: f.app.id, tool: ToolName.make("mutations.count") }),
            { status: "completed", value: 1 },
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

const atTime = <A, E, R>(now: number, work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    return yield* work.pipe(
      Effect.provideService(Clock.Clock, {
        currentTimeMillis: Effect.succeed(now),
        currentTimeMillisUnsafe: () => now,
        currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
        currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: (duration) => clock.sleep(duration),
      }),
    );
  });

test(
  "cleanup removes expired pending payloads and consumed markers, preserving live and other-owner requests",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const expired = yield* pending(f);
          const consumed = yield* pending(f);
          yield* f.executor.tools.resume({
            requestId: consumed.requestId,
            response: { action: "decline" },
          });
          const foreignOwner = OwnerId.make("other-approval-owner");
          const other = yield* f.executor.apps.copy({
            from: f.app.id,
            owner: foreignOwner,
            name: "Other",
          });
          yield* f.executor.apps.update({ app: other.id, accounts: { service: f.account.id } });
          const foreign = yield* f.executor.tools.call({ app: other.id, tool });
          assert.equal(foreign.status, "approval-required");
          if (foreign.status !== "approval-required") throw new Error("Expected pending");
          const live = yield* atTime(expired.expiresAt - 1, pending(f));
          const afterExpiry =
            Math.max(expired.expiresAt, consumed.expiresAt, foreign.expiresAt) + 1;
          yield* atTime(afterExpiry, f.executor.tools.pruneApprovals({ owner }));
          const rows = yield* f.options.storage.orm("3.0.0").findMany("toolApprovals", {});
          assert.deepEqual(
            new Set(rows.map(({ id }) => id)),
            new Set([live.requestId, foreign.requestId]),
          );
          assert.ok(
            Schema.is(ToolApprovalNotFound)(
              yield* Effect.flip(
                f.executor.tools.resume({
                  requestId: consumed.requestId,
                  response: { action: "accept" },
                }),
              ),
            ),
          );
          // The Promise API can be called by an idle host's scheduled cleanup without an approval decision.
          const promise = yield* Effect.promise(() => createPromiseExecutor(f.options));
          yield* Effect.promise(() => promise.tools.pruneApprovals({ owner: foreignOwner }));
          yield* atTime(afterExpiry, f.executor.tools.pruneApprovals());
          assert.deepEqual(
            (yield* f.options.storage.orm("3.0.0").findMany("toolApprovals", {})).map(
              ({ id }) => id,
            ),
            [live.requestId],
          );
          yield* atTime(live.expiresAt, f.executor.tools.pruneApprovals());
          assert.deepEqual(yield* f.options.storage.orm("3.0.0").findMany("toolApprovals", {}), []);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test("saving another approval prunes expired payloads and markers", { timeout: 20_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const expired = yield* pending(f);
        const consumed = yield* pending(f);
        yield* f.executor.tools.resume({
          requestId: consumed.requestId,
          response: { action: "decline" },
        });
        const fresh = yield* atTime(
          Math.max(expired.expiresAt, consumed.expiresAt) + 1,
          pending(f),
        );
        assert.deepEqual(
          (yield* f.options.storage.orm("3.0.0").findMany("toolApprovals", {})).map(({ id }) => id),
          [fresh.requestId],
        );
      }).pipe(Effect.provide(services)),
    ),
  ),
);

test("simultaneous pending resumes compete for one consumption", { timeout: 20_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* pending(f);
        const second = yield* createExecutor(f.options);
        const results = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) =>
            (i % 2 === 0 ? f.executor : second).tools.resume({
              requestId: request.requestId,
              response: { action: "accept" },
            }),
          ),
          { concurrency: 8 },
        );
        assert.equal(results.filter((result) => result.status === "completed").length, 1);
        assert.equal(results.filter((result) => result.status === "already-consumed").length, 7);
        assert.deepEqual(
          yield* f.executor.tools.call({ app: f.app.id, tool: ToolName.make("mutations.count") }),
          { status: "completed", value: 1 },
        );
        const row = yield* f.options.storage
          .orm("3.0.0")
          .findFirst("toolApprovals", { where: (b) => b("id", "=", request.requestId) });
        assert.ok(row);
        assert.equal(row.encrypted.byteLength, 0);
      }).pipe(Effect.provide(services)),
    ),
  ),
);

test(
  "elicitation cancel consumes without running and stays distinct from decline",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          const cancelled = yield* f.executor.tools.resume({
            requestId: request.requestId,
            response: { action: "cancel" },
          });
          assert.deepEqual(cancelled, { status: "cancelled", requestId: request.requestId });
          assert.deepEqual(
            yield* f.executor.tools.resume({
              requestId: request.requestId,
              response: { action: "accept", content: {} },
            }),
            {
              status: "already-consumed",
              requestId: request.requestId,
            },
          );
          const row = yield* f.options.storage
            .orm("3.0.0")
            .findFirst("toolApprovals", { where: (b) => b("id", "=", request.requestId) });
          assert.ok(row);
          assert.equal(row.encrypted.byteLength, 0);
          assert.deepEqual(
            yield* f.executor.tools.call({ app: f.app.id, tool: ToolName.make("mutations.count") }),
            { status: "completed", value: 0 },
          );
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "malformed elicitation responses cannot consume or alter the reviewed call",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const request = yield* pending(f);
          const invalid = {
            requestId: request.requestId,
            response: { action: "accept" as const, content: { amount: 999 } },
          };
          assert.ok(
            Schema.is(RequestInvalid)(yield* Effect.flip(f.executor.tools.resume(invalid))),
          );
          const promise = yield* Effect.promise(() => createPromiseExecutor(f.options));
          const invalidResponses: readonly unknown[] = [
            { action: "approve" },
            { action: "cancel", content: {} },
            { action: "decline", content: {} },
            { action: "accept", content: { amount: 999 } },
          ];
          for (const response of invalidResponses) {
            yield* Effect.promise(() =>
              assert.rejects(
                Reflect.apply(promise.tools.resume, promise.tools, [
                  { requestId: request.requestId, response },
                ]),
                Schema.is(RequestInvalid),
              ),
            );
          }
          const row = yield* f.options.storage
            .orm("3.0.0")
            .findFirst("toolApprovals", { where: (b) => b("id", "=", request.requestId) });
          assert.equal(row?.status, "pending");
          const result = yield* f.executor.tools.resume({
            requestId: request.requestId,
            response: { action: "accept", content: {} },
          });
          assert.deepEqual(result, {
            status: "completed",
            value: {
              version: "first",
              count: 1,
              token: "synthetic-secret",
              input: request.invocation.input,
            },
          });
        }).pipe(Effect.provide(services)),
      ),
    ),
);
