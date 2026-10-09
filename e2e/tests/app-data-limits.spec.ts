/**
 * App SQL rules: migrations are the database and their history cannot change, queries never
 * commit anything, transactions are synchronous, and large reads and writes are not capped.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const items = {
  path: "migrations/0001_items.sql",
  content: "CREATE TABLE items (grp TEXT NOT NULL, n INTEGER NOT NULL CHECK (n <> -999));\n",
};

const source = {
  path: "index.ts",
  content: `import { defineApp, mutation, query, router, number, object, string } from "apps";
// One statement writes count rows without a slow loop.
const insert = "INSERT INTO items (grp, n) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT 'g', x FROM c";
export default defineApp({ accounts: {} }, {
  tools: router({
    count: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("SELECT count(*) AS n FROM items").one().n),
    // Pairing every row with every row reads about the square of the row count.
    pairs: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("SELECT count(*) AS n FROM items a JOIN items b").one().n),
    seed: mutation({ input: object({ count: number() }) }, async ({ sql }, { count }) =>
      sql.exec(insert, count).rowsWritten),
    // Words that name statements are ordinary names in a read.
    keywordNames: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("SELECT 1 AS pragma, 2 AS analyze, 3 AS vacuum, 4 AS reindex").one().pragma),
    // A write after a read in one script is caught by SQLite's change count.
    hiddenWrite: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("SELECT 1 AS begin; INSERT INTO items (grp, n) VALUES ('x', -2); SELECT 1").toArray()),
    // A schema change in a query is rolled back with the rest of it.
    hiddenTable: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("CREATE TABLE sneaky (id TEXT); SELECT 1 AS n").one().n),
    tableExists: query({ input: object({ name: string() }) }, async ({ sql }, { name }) =>
      sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = ?", name).one().n),
    // Connection settings survive rollback, so app code cannot change them.
    loosen: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("PRAGMA ignore_check_constraints = ON").toArray()),
    violate: mutation({ input: object({}) }, async ({ sql }) =>
      sql.exec("INSERT INTO items (grp, n) VALUES ('x', -999)").rowsWritten),
    // Durable Objects run each statement as a savepoint, which keeps even this setting.
    defer: query({ input: object({}) }, async ({ sql }) =>
      sql.exec("PRAGMA defer_foreign_keys = ON").toArray()),
    // A script refused for changing a setting writes nothing.
    loosenAndWrite: mutation({ input: object({}) }, async ({ sql }) =>
      sql.exec("PRAGMA ignore_check_constraints = ON; INSERT INTO items (grp, n) VALUES ('x', -999)").rowsWritten),
    // A statement that fails inside a transaction fails it whole, even when caught.
    caughtFailure: mutation({ input: object({}) }, async ({ sql }) =>
      sql.transaction((tx) => {
        tx.exec("INSERT INTO items (grp, n) VALUES ('x', -6)");
        try { tx.exec("INSERT INTO missing_table (n) VALUES (1)"); } catch {}
        return 1;
      })),
    // An awaiting callback would commit what ran before its await.
    awaiting: mutation({ input: object({}) }, async ({ sql }) =>
      sql.transaction(async (tx) => {
        tx.exec("INSERT INTO items (grp, n) VALUES ('x', -3)");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 1;
      })),
    // A transaction's tx stops working when its callback returns.
    escaped: mutation({ input: object({}) }, async ({ sql }) => {
      let kept;
      sql.transaction((tx) => { kept = tx; });
      return kept.exec("INSERT INTO items (grp, n) VALUES ('x', -4)").rowsWritten;
    }),
  }),
});`,
};

const files = [source, items, appsManifest];

/** An app with no migrations has no database; its `ctx.sql` says so. */
const withoutDatabase = [
  {
    path: "index.ts",
    content: `import { defineApp, query, router, object } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({ count: query({ input: object({}) }, async ({ sql }) => sql.exec("SELECT 1 AS n").one().n) }),
});`,
  },
  appsManifest,
];

const CallFailed = Schema.Struct({ _tag: Schema.Literal("ToolCallFailed"), reason: Schema.String });
const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("DeploymentBuildFailed"),
  reason: Schema.String,
  stage: Schema.optionalKey(Schema.String),
});
const Active = Schema.Struct({ activeDeployment: Schema.String });

layer(HostedLive, { excludeTestServices: true })("App data limits", (it) => {
  it.effect(scenarios.appDataLimits.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployNew = (name: string, sources: readonly unknown[]) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: sources,
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });

        const app = yield* deployNew("Data limits", files);
        const kinds = {
          count: "query",
          pairs: "query",
          seed: "mutation",
          keywordNames: "query",
          hiddenWrite: "query",
          hiddenTable: "query",
          tableExists: "query",
          loosen: "query",
          violate: "mutation",
          defer: "query",
          loosenAndWrite: "mutation",
          caughtFailure: "mutation",
          awaiting: "mutation",
          escaped: "mutation",
        } as const;
        const call = (
          tool: keyof typeof kinds,
          input: Record<string, number | string> = {},
          id = app.id,
        ) =>
          api.request(actors.owner, "POST", `${prefix}/${id}/tools/call`, {
            tool,
            kind: kinds[tool],
            input,
          });
        const failure = (tool: keyof typeof kinds, id = app.id) =>
          Effect.gen(function* () {
            const response = yield* call(tool, {}, id);
            expect(response.status, JSON.stringify(response.body)).toBe(502);
            return (yield* body(CallFailed, response)).reason;
          });

        // A failing deploy names the file and SQLite's reason, applies none of its migrations,
        // and leaves the previous deployment active.
        const active = () =>
          api
            .request(actors.owner, "GET", `${prefix}/${app.id}`)
            .pipe(Effect.flatMap((response) => body(Active, response)));
        const before = yield* active();
        const rejectedWith = (sources: readonly unknown[]) =>
          Effect.gen(function* () {
            const rejected = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/${app.id}/deploy`,
              { files: sources },
            );
            expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
            const failed = yield* body(BuildFailed, rejected);
            expect(failed.stage).toBe("migrate");
            expect(yield* active()).toEqual(before);
            return failed.reason;
          });
        const typo = yield* rejectedWith([
          ...files,
          {
            path: "migrations/0002_good.sql",
            content: "CREATE TABLE applied_first (id TEXT);\n",
          },
          { path: "migrations/0003_typo.sql", content: "CREATE TABL typo (id TEXT);\n" },
        ]);
        expect(typo).toContain("migrations/0003_typo.sql failed");
        expect(typo).toContain("syntax error");
        expect(typo).toContain("No migrations were applied");
        expect(
          yield* body(Schema.Number, yield* call("tableExists", { name: "applied_first" })),
        ).toBe(0);

        // Applied migrations cannot be edited, renamed or removed; a misnamed file is refused.
        expect(
          yield* rejectedWith([
            source,
            { ...items, content: "CREATE TABLE items (grp TEXT, n INTEGER, extra TEXT);\n" },
            appsManifest,
          ]),
        ).toContain("migrations/0001_items.sql changed after it was applied");
        expect(
          yield* rejectedWith([
            source,
            { ...items, path: "migrations/0001_renamed.sql" },
            appsManifest,
          ]),
        ).toContain("but the build has migrations/0001_renamed.sql in its place");
        expect(yield* rejectedWith([source, appsManifest])).toContain(
          "this app's database has applied migrations, but the build has no migrations/",
        );
        expect(
          yield* rejectedWith([
            source,
            { path: "migrations/0002_other.sql", content: "CREATE TABLE other (id TEXT);\n" },
            appsManifest,
          ]),
        ).toContain("Migration 1 was applied as migrations/0001_items.sql");
        expect(
          yield* rejectedWith([...files, { path: "migrations/next.sql", content: "SELECT 1;\n" }]),
        ).toContain("migrations/next.sql: migrations are files directly in migrations/");

        // Calls have no row budget: pairing 400 rows reads about 160,000, and one call writes
        // 20,000 rows.
        expect(yield* body(Schema.Number, yield* call("seed", { count: 400 }))).toBe(400);
        expect(yield* body(Schema.Number, yield* call("pairs"))).toBe(160_000);
        expect(yield* body(Schema.Number, yield* call("seed", { count: 20_000 }))).toBe(20_000);
        expect(yield* body(Schema.Number, yield* call("keywordNames"))).toBe(1);

        // A query commits nothing: a write in it fails, and a schema change in it is undone.
        expect(yield* failure("hiddenWrite")).toContain("Queries are read-only");
        expect(yield* body(Schema.Number, yield* call("hiddenTable"))).toBe(1);
        expect(yield* body(Schema.Number, yield* call("tableExists", { name: "sneaky" }))).toBe(0);

        // A query cannot turn off CHECK constraints for later calls.
        expect(yield* failure("loosen")).toContain("cannot change PRAGMA ignore_check_constraints");
        expect(yield* failure("violate")).toContain("CHECK constraint failed");
        expect(yield* failure("defer")).toContain("cannot change PRAGMA defer_foreign_keys");
        expect(yield* failure("loosenAndWrite")).toContain(
          "cannot change PRAGMA ignore_check_constraints",
        );

        // Failed statements fail their transaction; transactions are synchronous; a tx does not
        // outlive its callback.
        expect(yield* failure("caughtFailure")).toContain("no such table");
        expect(yield* failure("awaiting")).toContain("cannot await");
        expect(yield* failure("escaped")).toContain("transaction has ended");
        expect(yield* body(Schema.Number, yield* call("count"))).toBe(20_400);

        // Without migrations an app has no database, and its SQL says how to add one.
        const plain = yield* deployNew("No database", withoutDatabase);
        expect(yield* failure("count", plain.id)).toContain("This app has no database");

        // Reactivating a deployment from before the app had migrations does not let a later
        // deploy drop them.
        const plainPath = `${prefix}/${plain.id}`;
        const activeOf = () =>
          api
            .request(actors.owner, "GET", plainPath)
            .pipe(Effect.flatMap((response) => body(Active, response)));
        const first = yield* activeOf();
        const migrated = yield* api.request(actors.owner, "POST", `${plainPath}/deploy`, {
          files: [...withoutDatabase, items],
        });
        expect(migrated.status, JSON.stringify(migrated.body)).toBe(200);
        const second = yield* activeOf();
        const reactivated = yield* api.request(actors.owner, "POST", `${plainPath}/activate`, {
          deployment: first.activeDeployment,
          expectedDeployment: second.activeDeployment,
        });
        expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
        const dropped = yield* api.request(actors.owner, "POST", `${plainPath}/deploy`, {
          files: withoutDatabase,
        });
        expect(dropped.status, JSON.stringify(dropped.body)).toBe(422);
        expect((yield* body(BuildFailed, dropped)).reason).toContain(
          "this app's database has applied migrations, but the build has no migrations/",
        );
      }),
    ),
  );
});
