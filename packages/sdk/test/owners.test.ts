/** Owner purge over real SQL: every owned row goes, other owners are untouched. */
import { memorySourceStorage } from "@executor-js/sdk/testing";
import { database } from "../src/implementation/database.ts";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  AppWorkflowsActive,
  BuildId,
  OwnerId,
  OwnerWebhooksActive,
  WebhookId,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
  type ExecutorOptions,
  type Runtime,
} from "@executor-js/sdk/core";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";
import { storageSchema } from "../src/implementation/storage-schema.ts";

const alice = OwnerId.make("organization:alice");
const bob = OwnerId.make("organization:bob");
const files = [
  { path: "index.ts", content: "synthetic source handled by the supplied runtime" },
] as const;
const runtime: Runtime = {
  build: () =>
    Effect.succeed({
      build: BuildId.make("bld_fixture"),
      requirements: {
        accounts: {
          service: {
            cardinality: "one",
            definition: {
              name: "Synthetic",
              auth: {
                key: {
                  type: "secrets",
                  label: "API key",
                  fields: {
                    type: "object",
                    properties: { token: { type: "string" } },
                    required: ["token"],
                  },
                },
              },
            },
          },
        },
      },
    }),
  workflow: () => Effect.die("Unexpected workflow invocation"),
  webhook: () => Effect.die("Unexpected webhook invocation"),
  skills: () => Effect.die("This fixture does not load skills"),
  inspect: () => Effect.succeed([]),
  index: () => Effect.succeed([]),
  query: () => Effect.succeed(null),
  mutate: () => Effect.succeed(null),
  call: () => Effect.succeed(null),
};

const fixture = Effect.gen(function* () {
  const storage = yield* makeExecutorStorage({ provider: "postgresql" });
  yield* storage.migrate;
  const credentialStore = yield* credentials(Redacted.make("ab".repeat(32)), crypto);
  return {
    blobs: memoryBlobStore(),
    sources: memorySourceStorage(),
    storage,
    credentials: credentialStore,
    runtime: runtimeAdapter(runtime),
  } satisfies ExecutorOptions;
});
const services = Layer.mergeAll(BrowserCrypto.layer, pgliteLayer());

const populate = (executor: Effect.Success<ReturnType<typeof createExecutor>>, owner: OwnerId) =>
  Effect.gen(function* () {
    const { app } = yield* executor.apps.deploy({ owner, name: "Example", files });
    const requirement = app.requirements.accounts.service;
    assert.ok(requirement);
    const account = yield* executor.accounts.add({
      owner,
      provider: requirement.provider,
      method: "key",
      label: "Work",
      fields: Redacted.make({ token: "synthetic-token" }),
    });
    yield* executor.apps.profiles.create({
      app: app.id,
      owner,
      subject: owner,
      idempotencyKey: "owner-purge-fixture",
      accounts: { service: account.id },
    });
    yield* executor.accountConnections.create({ owner, provider: requirement.provider });
    return { app, account };
  });

test(
  "removing an owner deletes its apps, accounts, deployments and connections",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture;
          const executor = yield* createExecutor(options);
          const db = database(options.storage);
          const rows = (table: "deployments" | "accountConnections", owner: OwnerId) =>
            db.findMany(table, { select: ["id"], where: (b) => b("owner", "=", owner) });
          yield* populate(executor, alice);
          const theirs = yield* populate(executor, bob);

          const removed = yield* executor.owners.remove({ owner: alice });
          assert.deepEqual(removed, {
            owner: alice,
            apps: 1,
            accounts: 1,
            deployments: 1,
            connections: 1,
          });

          assert.deepEqual(yield* executor.apps.list({ owner: alice }), []);
          assert.deepEqual(yield* executor.accounts.list({ owner: alice }), []);
          // Retained code and the pending connection are deleted, not merely unreferenced.
          assert.deepEqual(yield* rows("deployments", alice), []);
          assert.deepEqual(yield* rows("accountConnections", alice), []);

          // A second owner's identical records survive an unrelated purge.
          assert.equal((yield* executor.apps.list({ owner: bob })).length, 1);
          assert.equal((yield* executor.accounts.list({ owner: bob })).length, 1);
          assert.equal((yield* executor.apps.deployments({ app: theirs.app.id })).length, 1);
          assert.equal((yield* rows("accountConnections", bob)).length, 1);

          // Repeating the purge is safe and reports nothing left to remove.
          assert.deepEqual(yield* executor.owners.remove({ owner: alice }), {
            owner: alice,
            apps: 0,
            accounts: 0,
            deployments: 0,
            connections: 0,
          });
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "a live webhook subscription stops the purge and keeps every record",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture;
          const executor = yield* createExecutor(options);
          const mine = yield* populate(executor, alice);
          const db = database(options.storage);
          // Stand in for a provider registration this owner still holds.
          yield* db.create("webhooks", {
            id: WebhookId.make("whk_live"),
            app: mine.app.id,
            owner: alice,
            key: "synthetic",
            deployment: mine.app.activeDeployment,
            name: "Synthetic",
            sourceAccount: mine.account.id,
            callbackUrl: "https://example.test/hook",
            accounts: {},
            status: "active",
            revision: "1",
            leaseUntil: new Date(0),
            failure: null,
            encrypted: new Uint8Array([1]),
            createdAt: new Date(0),
          });

          const failure = yield* Effect.flip(executor.owners.remove({ owner: alice }));
          assert.ok(Schema.is(OwnerWebhooksActive)(failure));
          assert.deepEqual(failure.subscriptions, ["whk_live"]);
          assert.equal((yield* executor.apps.list({ owner: alice })).length, 1);
          assert.equal((yield* executor.accounts.list({ owner: alice })).length, 1);
        }).pipe(Effect.provide(services)),
      ),
    ),
);

/**
 * Enumerated from the schema rather than written out, so a table added later with
 * an `owner` column fails this test until both the purge and this fixture cover it.
 */
const ownerTables = Object.entries(storageSchema.tables)
  .filter(([, definition]) => "owner" in definition.columns)
  .map(([name]) => name)
  .sort();

/** The ORM is generic over its table names; these tests address tables by string. */
type Comparison = (column: string, operator: string, value: string) => unknown;
type AnyTable = {
  readonly create: (
    table: string,
    values: Record<string, unknown>,
  ) => Effect.Effect<unknown, unknown>;
  readonly findMany: (
    table: string,
    options: {
      readonly select: ReadonlyArray<string>;
      readonly where: (b: Comparison) => unknown;
    },
  ) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
};

/** Rows the app and account APIs cannot create, one per remaining owner-bearing table. */
const seedRows = (
  db: AnyTable,
  owner: OwnerId,
  context: { readonly app: string; readonly account: string; readonly deployment: string },
) =>
  Effect.gen(function* () {
    const epoch = new Date(0);
    yield* db.create("profiles", {
      id: `ins_${owner}`,
      app: context.app,
      owner,
      subject: `subject:${owner}`,
      name: null,
      idempotencyKey: `profile:${owner}`,
      accounts: {},
      webhookConfig: {},
      revision: 1,
      enabled: true,
      status: "ready",
      failure: null,
      reconciledDeployment: context.deployment,
      reconciledRevision: 1,
      request: {},
      lease: null,
      leaseUntil: epoch,
      createdAt: epoch,
    });
    yield* db.create("toolApprovals", {
      id: `apr_${owner}`,
      owner,
      status: "pending",
      revision: "1",
      encrypted: new Uint8Array([1]),
      expiresAt: epoch,
    });
    yield* db.create("webhooks", {
      id: `whk_${owner}`,
      app: context.app,
      owner,
      key: "synthetic",
      deployment: context.deployment,
      name: "Synthetic",
      sourceAccount: context.account,
      callbackUrl: "https://example.test/hook",
      accounts: {},
      // Stopped, so the purge is not refused; the row must still be deleted.
      status: "stopped",
      revision: "1",
      leaseUntil: epoch,
      failure: null,
      encrypted: new Uint8Array([1]),
      createdAt: epoch,
    });
    yield* db.create("workflowRuns", {
      id: `wfr_${owner}`,
      app: context.app,
      owner,
      key: "synthetic",
      deployment: context.deployment,
      name: "synthetic",
      accounts: {},
      status: "succeeded",
      failure: null,
      encrypted: new Uint8Array([1]),
      createdAt: epoch,
    });
    yield* db.create("schedules", {
      id: `sch_${owner}`,
      app: context.app,
      owner,
      name: "nightly",
      actor: "user:synthetic",
      timing: { kind: "interval", every: "1 day" },
      enabled: true,
      approvalMode: "automatic",
      nextAt: epoch,
      activeRun: null,
      revision: "1",
    });
    yield* db.create("scheduledRuns", {
      id: `scr_${owner}`,
      scheduleId: `sch_${owner}`,
      app: context.app,
      owner,
      name: "nightly",
      status: "failed",
      scheduledAt: epoch,
      startedAt: epoch,
      finishedAt: epoch,
      requestId: null,
      expiresAt: null,
      failure: "AppNotFound",
      runner: "synthetic",
      revision: "1",
      answer: null,
    });
  });

test(
  "removing an owner empties every owner-bearing table in the current schema",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture;
          const executor = yield* createExecutor(options);
          const db = options.storage.orm(storageSchema.version) as unknown as AnyTable;
          const owned = (table: string, owner: OwnerId) =>
            db.findMany(table, {
              select: ["id"],
              where: (b) => b("owner", "=", owner),
            });

          const mine = yield* populate(executor, alice);
          const theirs = yield* populate(executor, bob);
          for (const [owner, populated] of [
            [alice, mine],
            [bob, theirs],
          ] as const) {
            yield* executor.apps.profiles.create({
              app: populated.app.id,
              owner,
              subject: "user:synthetic",
              accounts: {},
              idempotencyKey: "owner-purge",
            });
            yield* seedRows(db, owner, {
              app: populated.app.id,
              account: populated.account.id,
              deployment: populated.app.activeDeployment,
            });
          }

          // The fixture must reach every owner-bearing table, or "empty afterwards"
          // would pass for a table nothing ever wrote to.
          for (const table of ownerTables)
            assert.ok(
              (yield* owned(table, alice)).length > 0,
              `Nothing seeded ${table} for the owner under test`,
            );

          yield* executor.owners.remove({ owner: alice });

          for (const table of ownerTables) {
            assert.deepEqual(yield* owned(table, alice), [], `owners.remove left rows in ${table}`);
            // The same purge must not reach another owner's copy of any of them.
            assert.ok(
              (yield* owned(table, bob)).length > 0,
              `owners.remove deleted an unrelated owner's ${table}`,
            );
          }
        }).pipe(Effect.provide(services)),
      ),
    ),
);

test(
  "a running workflow refuses the pre-purge check before anything is removed",
  { timeout: 20_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = yield* fixture;
          const executor = yield* createExecutor(options);
          const db = options.storage.orm(storageSchema.version) as unknown as AnyTable;
          const mine = yield* populate(executor, alice);

          // With no work in flight the check passes and reports the owner it read.
          assert.deepEqual(yield* executor.owners.check({ owner: alice }), { owner: alice });

          yield* db.create("workflowRuns", {
            id: "wfr_running",
            app: mine.app.id,
            owner: alice,
            key: "synthetic",
            deployment: mine.app.activeDeployment,
            name: "synthetic",
            accounts: {},
            status: "running",
            failure: null,
            encrypted: new Uint8Array([1]),
            createdAt: new Date(0),
          });

          const failure = yield* Effect.flip(executor.owners.check({ owner: alice }));
          assert.ok(Schema.is(AppWorkflowsActive)(failure));
          assert.equal(failure.app, mine.app.id);
          // The check reads only, so a refusal costs the caller nothing.
          assert.equal((yield* executor.apps.list({ owner: alice })).length, 1);
          assert.equal((yield* executor.accounts.list({ owner: alice })).length, 1);
        }).pipe(Effect.provide(services)),
      ),
    ),
);
