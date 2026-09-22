import { memorySourceStorage } from "@executor-js/sdk/testing";
import { database } from "../src/implementation/database.ts";
/** Lists run against real Postgres storage; SQL spans expose redundant database reads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Effect, Layer, Redacted, Result, Schema, Tracer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import {
  AccountId,
  AppCodeId,
  AppId,
  AppNotFound,
  AppSlug,
  BuildId,
  DeploymentId,
  DeploymentNotFound,
  OwnerId,
  ProviderId,
  StorageError,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";

const owner = OwnerId.make("list-owner");
const otherOwner = OwnerId.make("list-other-owner");
const provider = ProviderId.make("prv_list");
const account = AccountId.make("acc_list");
const definition = { name: "Synthetic", auth: {} };
const requirements = (index: number) => ({
  accounts: {
    [`service${index}`]: { provider, definition, cardinality: "one" as const },
  },
});
const services = Layer.mergeAll(BrowserCrypto.layer, pgliteLayer());

const fixture = (count: number) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    const db = database(storage);
    const deployments = Array.from({ length: count + 1 }, (_, index) => ({
      id: DeploymentId.make(`dpl_list_${index}`),
      code: AppCodeId.make(`code_list_${index}`),
      // Configured copies can retain deployments owned by somebody else.
      owner: otherOwner,
      // Listing must not parse or fetch retained source content.
      sourceCommit: "a".repeat(40),
      fileCount: 1,
      build: BuildId.make(`bld_list_${index}`),
      requirements: requirements(index),
      createdAt: new Date(0),
    }));
    const apps = deployments.map((deployment, index) => ({
      id: AppId.make(`app_list_${String(index).padStart(3, "0")}`),
      code: deployment.code,
      copiedFrom: null,
      owner: index === count ? otherOwner : owner,
      name: `app-${index}`,
      slug: AppSlug.make(`app-${index}`),
      activeDeployment: deployment.id,
      accounts: index % 2 === 0 ? { service: account } : {},
      createdAt: new Date(index),
    }));
    yield* db.create("providers", { id: provider, definition });
    yield* db.createMany(
      "accounts",
      [owner, otherOwner].map((accountOwner) => ({
        id: accountOwner === owner ? account : AccountId.make("acc_list_other"),
        owner: accountOwner,
        provider,
        method: "key",
        label: "Synthetic account",
        encryptedCredentials: new Uint8Array([1, 2, 3]),
        createdAt: new Date(0),
      })),
    );
    yield* db.createMany("deployments", deployments);
    yield* db.createMany("apps", [...apps].reverse());
    const executor = yield* createExecutor({
      storage,
      sources: memorySourceStorage(),
      blobs: memoryBlobStore(),
      credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
      runtime: runtimeAdapter({
        build: () => Effect.die("List must not build code"),
        inspect: () => Effect.die("List must not evaluate code"),
        call: () => Effect.die("List must not run tools"),
        query: () => Effect.die("List must not run queries"),
        mutate: () => Effect.die("List must not run mutations"),
        webhook: () => Effect.die("List must not handle webhooks"),
        workflow: () => Effect.die("List must not run workflows"),
      }),
    });
    return { executor, db, apps, deployments };
  });

const measured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const spans: Tracer.Span[] = [];
    const value = yield* effect.pipe(
      Effect.provideService(
        Tracer.Tracer,
        Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        }),
      ),
    );
    return {
      value,
      queries: spans
        .filter((span) => span.name === "sql.execute")
        .map((span) =>
          Schema.decodeUnknownSync(Schema.String)(span.attributes.get("db.query.text")),
        ),
    };
  });

test("app and build metadata remain available without Git and enforce owner and lineage", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // The real database has retained references, but the source backend is empty.
        const { executor, apps, deployments } = yield* fixture(1);
        const app = apps[0],
          retained = deployments[0],
          foreign = deployments[1];
        assert.ok(app && retained && foreign);
        const read = yield* measured(executor.apps.get({ app: app.id, owner }));
        assert.equal(read.queries.length, 1);
        assert.deepEqual(read.value.requirements, requirements(0));
        const metadata = yield* executor.apps.deployment({ app: app.id, owner });
        assert.equal(metadata.id, retained.id);
        assert.equal(metadata.build, retained.build);
        assert.equal(metadata.sourceCommit, retained.sourceCommit);
        assert.ok(!("files" in metadata));
        const wrongOwner = yield* executor.apps
          .deployment({ app: app.id, owner: otherOwner })
          .pipe(Effect.result);
        assert.ok(Result.isFailure(wrongOwner) && Schema.is(AppNotFound)(wrongOwner.failure));
        for (const input of [{ deployment: foreign.id }, { deploymentOwner: owner }]) {
          yield* executor.apps.deployment({ app: app.id, owner, ...input }).pipe(
            Effect.result,
            Effect.tap((denied) =>
              Effect.sync(() =>
                assert.ok(
                  Result.isFailure(denied) && Schema.is(DeploymentNotFound)(denied.failure),
                ),
              ),
            ),
          );
        }
        const source = yield* executor.apps.source({ app: app.id, owner }).pipe(Effect.result);
        assert.ok(Result.isFailure(source), "Source inspection still needs the source backend");
      }),
    ).pipe(Effect.provide(services)),
  ));

for (const count of [25, 125]) {
  test(`app list projects ${count} rows with one database read`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { executor, apps } = yield* fixture(count);
          const result = yield* measured(executor.apps.list({ owner }));
          assert.deepEqual(
            result.value,
            apps
              .slice(0, count)
              .map((app, index) => ({ ...app, requirements: requirements(index) })),
          );
          assert.equal(
            result.queries.length,
            1,
            "App listing must not issue one deployment read per row",
          );
          assert.ok(
            result.queries.every((query) => !query.includes('"files"')),
            "Retained source files must not be selected",
          );
          const accounts = yield* measured(executor.accounts.list({ owner, provider }));
          assert.equal(accounts.value.length, 1);
          assert.equal(accounts.value[0]?.id, account);
          assert.equal(accounts.queries.length, 1);
          assert.ok(accounts.queries.every((query) => !query.includes('"encrypted_credentials"')));
        }),
      ).pipe(Effect.provide(services)),
    ));
}

test("app list keeps owner, ID, name, slug and selected-account filters and empty results", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, apps } = yield* fixture(4);
        const first = apps[0];
        const last = apps[3];
        assert.ok(first && last);
        for (const input of [{ name: first.name }, { slug: first.slug }, { ids: [first.id] }]) {
          assert.deepEqual(
            (yield* executor.apps.list({ owner, ...input })).map((app) => app.id),
            [first.id],
          );
        }
        assert.deepEqual(
          (yield* executor.apps.list({ owner, ids: [last.id, first.id] })).map((app) => app.id),
          [first.id, last.id],
        );
        assert.equal((yield* executor.apps.list()).length, 5);
        assert.equal((yield* executor.apps.list({ owner, account })).length, 2);
        for (const input of [
          { owner, ids: [] },
          { owner, name: "missing" },
          { owner: OwnerId.make("absent") },
        ]) {
          const result = yield* measured(executor.apps.list(input));
          assert.deepEqual(result.value, []);
          assert.equal(result.queries.length, 1);
        }
      }),
    ).pipe(Effect.provide(services)),
  ));

test("app list rejects missing, wrong-lineage and corrupt references without leaking foreign rows", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, apps, deployments, db } = yield* fixture(1);
        const sql = yield* SqlClient.SqlClient;
        const app = apps[0];
        const foreign = apps[1];
        const deployment = deployments[0];
        const otherDeployment = deployments[1];
        assert.ok(app && foreign && deployment && otherDeployment);
        // Simulate pre-existing corrupt data without changing the schema or normal write validation.
        const pointTo = (active: DeploymentId) =>
          Effect.acquireUseRelease(
            sql`set session_replication_role = replica`,
            () => sql`update executor_apps set active_deployment = ${active} where id = ${app.id}`,
            () => sql`set session_replication_role = origin`.pipe(Effect.orDie),
          );
        for (const active of [DeploymentId.make("dpl_missing"), otherDeployment.id]) {
          yield* pointTo(active);
          const result = yield* executor.apps.list({ owner }).pipe(Effect.result);
          assert.ok(Result.isFailure(result) && Schema.is(StorageError)(result.failure));
          assert.equal((yield* executor.apps.list({ owner: otherOwner })).length, 1);
        }
        yield* pointTo(deployment.id);
        yield* db.updateMany("deployments", {
          where: (b) => b("id", "=", deployment.id),
          set: { requirements: {} },
        });
        const corrupt = yield* executor.apps.list({ owner }).pipe(Effect.result);
        assert.ok(Result.isFailure(corrupt) && Schema.is(StorageError)(corrupt.failure));
        yield* db.updateMany("deployments", {
          where: (b) => b("id", "=", deployment.id),
          set: { requirements: deployment.requirements },
        });
        yield* db.updateMany("apps", {
          where: (b) => b("id", "=", app.id),
          set: { slug: AppSlug.make("wrong-slug") },
        });
        const invalidApp = yield* executor.apps.list({ owner }).pipe(Effect.result);
        assert.ok(Result.isFailure(invalidApp) && Schema.is(StorageError)(invalidApp.failure));
      }),
    ).pipe(Effect.provide(services)),
  ));
