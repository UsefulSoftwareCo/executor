/** Migrate current baseline rows through the same storage migration used by all products. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fumadb } from "fumadb-effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { sqlAdapter } from "fumadb-effect/sql";
import { makeExecutorStorage } from "../src/core.ts";
import { storageSchema } from "../src/implementation/storage-schema.ts";

const oldDatabase = fumadb({ namespace: "executor", schemas: [storageSchema] });
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const old = oldDatabase.client(sqlAdapter({ provider: "postgresql" }));
  yield* (yield* (yield* old.createMigrator).migrateToLatest()).execute;
  const seed = `
    INSERT INTO executor_providers (id, definition) VALUES ('prv_fixture', '{}');
    INSERT INTO executor_accounts (id, owner, provider, method, label, encrypted_credentials, created_at)
      VALUES ('acc_fixture', 'org_fixture', 'prv_fixture', 'key', 'Saved account', decode('010203', 'hex'), '2026-01-01');
    INSERT INTO executor_deployments (id, code, owner, build, requirements, created_at, source_commit, file_count)
      VALUES ('dpl_fixture', 'code_fixture', 'org_fixture', 'bld_fixture', '{"accounts":{"service":{"provider":"prv_fixture","cardinality":"one"}}}', '2026-01-01', repeat('a',40), 1);
    INSERT INTO executor_apps (id, code, repository, owner, name, active_deployment, copied_from, created_at, slug)
      VALUES ('app_fixture', 'code_fixture', 'code_fixture', 'org_fixture', 'Fixture', 'dpl_fixture', null, '2026-01-01', 'fixture');
    INSERT INTO executor_installations (id, app, owner, subject, name, idempotency_key, accounts, webhook_config, revision, enabled, status, failure, reconciled_deployment, reconciled_revision, request, lease, lease_until, created_at)
      VALUES ('ins_fixture', 'app_fixture', 'org_fixture', 'user_fixture', 'Personal', 'fixture', '{"service":"acc_fixture"}', '{}', 7, true, 'ready', null, 'dpl_fixture', 7, '{"accounts":{"service":"acc_fixture"}}', null, '2026-01-01', '2026-01-01');
    INSERT INTO executor_app_records (id, app, table_name, record_key, value)
      VALUES ('record_fixture', 'app_fixture', 'notes', 'one', '{"text":"Retain this document"}');
    INSERT INTO executor_workflow_runs (id, app, installation, installation_revision, owner, start_key, deployment, name, accounts, status, failure, encrypted, created_at)
      VALUES ('wfr_fixture', 'app_fixture', 'ins_fixture', 7, 'org_fixture', 'once', 'dpl_fixture', 'sync', '{"service":"acc_fixture"}', 'running', null, decode('040506', 'hex'), '2026-01-01');
    INSERT INTO executor_webhooks (id, app, installation, installation_revision, owner, subscription_key, deployment, name, source_account, callback_url, accounts, status, revision, lease_until, failure, encrypted, created_at)
      VALUES ('whk_fixture', 'app_fixture', 'ins_fixture', 7, 'org_fixture', 'events', 'dpl_fixture', 'events', 'acc_fixture', 'https://example.test/webhook', '{"service":"acc_fixture"}', 'ready', '1', '2026-01-01', null, decode('070809', 'hex'), '2026-01-01');
    INSERT INTO executor_schedules (id, app, installation, owner, name, actor, timing, enabled, approval_mode, next_at, active_run, revision)
      VALUES ('schedule_fixture', 'app_fixture', 'ins_fixture', 'org_fixture', 'sync', 'user_fixture', '{}', true, 'automatic', null, null, '1');
    INSERT INTO executor_scheduled_runs (id, schedule_id, app, installation, owner, name, status, scheduled_at, started_at, finished_at, request_id, expires_at, failure, runner, revision, answer)
      VALUES ('scheduled_run_fixture', 'schedule_fixture', 'app_fixture', 'ins_fixture', 'org_fixture', 'sync', 'running', '2026-01-01', '2026-01-01', null, null, null, null, 'runner_fixture', '1', null);
    INSERT INTO executor_account_connections (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
      VALUES ('con_fixture', 'org_fixture', 'prv_fixture', null, '{"status":"pending"}', '1', null, '2026-01-01', '2099-01-01', '{"app":"app_fixture","installation":"ins_fixture","requirement":"service","name":"Fixture","owner":"org_fixture","cardinality":"one","selection":null}');
    CREATE UNIQUE INDEX executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key);
    CREATE UNIQUE INDEX executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key);
    CREATE UNIQUE INDEX executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name);
    CREATE TABLE host_owned_fixture (id text primary key, payload text not null);
    INSERT INTO host_owned_fixture VALUES ('one', 'Keep host authentication and configuration');
  `;
  for (const statement of seed.split(";").filter((value) => value.trim().length > 0))
    yield* sql.unsafe(statement).unprepared;
  return { sql, old };
});

const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    ...Object.values(storageSchema.tables).map((table) => table.names.sql),
    "host_owned_fixture",
  ];
  return yield* Effect.forEach(
    tables,
    (table) =>
      sql`SELECT to_jsonb(record) AS value
      FROM ${sql(table)} record ORDER BY id`,
  );
});
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(pgliteLayer()))));

const indexNames = [
  "executor_scheduled_runs_owner",
  "executor_scheduled_runs_pending",
  "executor_schedules_context_name",
  "executor_schedules_due",
  "executor_webhooks_context_key",
  "executor_workflow_runs_context_key",
];
const savedIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ indexname: string }>`SELECT indexname FROM pg_indexes
    WHERE indexname IN ${sql.in(indexNames)} ORDER BY indexname`;
  return rows.map((row) => row.indexname);
});

test("fresh initialization includes every custom index and a second migration writes nothing", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      assert.deepEqual(yield* savedIndexes, indexNames);
      yield* sql.unsafe(
        `CREATE FUNCTION reject_settings_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'A current database must not be migrated again'; END $$`,
      ).unprepared;
      yield* sql.unsafe(
        `CREATE TRIGGER reject_settings_write BEFORE UPDATE ON private_executor_settings FOR EACH ROW EXECUTE FUNCTION reject_settings_write()`,
      ).unprepared;
      yield* storage.migrate;
      assert.deepEqual(yield* savedIndexes, indexNames);
    }),
  ));

test("version 4 repair restores missing indexes and preserves profiles, credentials, app data and work", () =>
  run(
    Effect.gen(function* () {
      const { sql, old } = yield* fixture;
      for (const name of indexNames) yield* sql`DROP INDEX IF EXISTS ${sql(name)}`;
      const before = yield* snapshot;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      assert.deepEqual(yield* savedIndexes, indexNames);
      assert.deepEqual(yield* snapshot, before);
      assert.deepEqual(yield* (yield* old.createMigrator).version, Option.some("4.0.1"));
      const profiles = yield* storage.orm("4.0.0").findMany("profiles", {});
      assert.equal(profiles[0]?.revision, 7);
      assert.deepEqual(profiles[0]?.accounts, { service: "acc_fixture" });
      const apps = yield* storage.orm("4.0.0").findMany("apps", { join: (b) => b.deployment() });
      assert.equal(apps[0]?.deployment?.id, "dpl_fixture");
      assert.equal(Object.hasOwn(apps[0] ?? {}, "accounts"), false);
      yield* storage.migrate;
      assert.deepEqual(yield* snapshot, before);
      const duplicate = yield* Effect.result(sql`INSERT INTO executor_workflow_runs
      SELECT 'duplicate', app, installation, installation_revision, owner, start_key, deployment, name, accounts, status, failure, encrypted, created_at
      FROM executor_workflow_runs WHERE id = 'wfr_fixture'`);
      assert.equal(Result.isFailure(duplicate), true);
    }),
  ));

test("a late migration failure rolls back index creation and can be retried without changing records", () =>
  run(
    Effect.gen(function* () {
      const { sql, old } = yield* fixture;
      const before = yield* snapshot;
      const indexesBefore = yield* savedIndexes;
      yield* sql.unsafe(
        `CREATE FUNCTION reject_upgrade() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic migration failure'; END $$`,
      ).unprepared;
      yield* sql.unsafe(
        `CREATE TRIGGER reject_upgrade BEFORE UPDATE ON private_executor_settings FOR EACH ROW WHEN (OLD.key = 'version') EXECUTE FUNCTION reject_upgrade()`,
      ).unprepared;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      assert.equal(Result.isFailure(yield* Effect.result(storage.migrate)), true);
      assert.deepEqual(yield* (yield* old.createMigrator).version, Option.some("4.0.0"));
      assert.deepEqual(yield* savedIndexes, indexesBefore);
      assert.deepEqual(yield* snapshot, before);
      yield* sql.unsafe("DROP TRIGGER reject_upgrade ON private_executor_settings").unprepared;
      yield* storage.migrate;
      assert.deepEqual(yield* snapshot, before);
      assert.deepEqual(yield* savedIndexes, indexNames);
      assert.deepEqual(yield* (yield* old.createMigrator).version, Option.some("4.0.1"));
    }),
  ));

for (const version of ["3.0.0", "5.0.0"]) {
  test(`unsupported version ${version} is refused before changing data`, () =>
    run(
      Effect.gen(function* () {
        const { sql, old } = yield* fixture;
        yield* sql`UPDATE private_executor_settings SET value = ${version} WHERE key = 'version'`;
        const before = yield* snapshot;
        const indexesBefore = yield* savedIndexes;
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        for (const operation of [storage.checkMigration, storage.migrate])
          assert.equal(Result.isFailure(yield* Effect.result(operation)), true);
        assert.deepEqual(yield* snapshot, before);
        assert.deepEqual(yield* savedIndexes, indexesBefore);
        assert.deepEqual(yield* (yield* old.createMigrator).version, Option.some(version));
      }),
    ));
}
