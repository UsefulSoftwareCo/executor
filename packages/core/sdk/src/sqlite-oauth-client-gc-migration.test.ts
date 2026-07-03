import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import { runSqliteOAuthClientGcMigration } from "./sqlite-oauth-client-gc-migration";

// Integration coverage for the local libSQL GC + backfill migration against a
// real SQLite schema (issue #1120, Part C). Complements the pure decision-matrix
// tests in oauth-gc.test.ts by exercising the actual SQL: seeded rows in, the
// migration runs, surviving rows asserted.

const TENANT = "t1";
const OWNER = "org";
const SUBJECT = "s1";

const withDb = <A>(body: (db: SqliteTestFumaDb) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) => Effect.promise(() => body(db)),
      (db) => Effect.promise(() => db.close()),
    ),
  );

const insertOAuthClient = (
  db: SqliteTestFumaDb,
  row: {
    readonly slug: string;
    readonly tokenUrl: string;
    readonly grant?: string;
    readonly resource?: string | null;
    readonly originKind?: string | null;
    readonly originIssuer?: string | null;
  },
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO oauth_client
      (row_id, tenant, owner, subject, slug, authorization_url, token_url, "grant",
       client_id, resource, origin_kind, origin_issuer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `oc_${row.slug}`,
      TENANT,
      OWNER,
      SUBJECT,
      row.slug,
      "https://as.example/authorize",
      row.tokenUrl,
      row.grant ?? "authorization_code",
      `client-${row.slug}`,
      row.resource ?? null,
      row.originKind ?? null,
      row.originIssuer ?? null,
      Date.now(),
    ],
  });

const insertConnection = (
  db: SqliteTestFumaDb,
  connectionName: string,
  clientSlug: string,
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO connection
      (row_id, tenant, owner, subject, integration, name, template, provider, item_ids,
       oauth_client, oauth_client_owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `cn_${connectionName}`,
      TENANT,
      OWNER,
      SUBJECT,
      "acme",
      connectionName,
      "oauth",
      "memory",
      "{}",
      clientSlug,
      OWNER,
      Date.now(),
      Date.now(),
    ],
  });

const slugs = async (db: SqliteTestFumaDb): Promise<readonly string[]> => {
  const result = await db.client.execute("SELECT slug FROM oauth_client ORDER BY slug");
  return result.rows.map((r) => String(r.slug));
};

const issuerOf = async (db: SqliteTestFumaDb, slug: string): Promise<string | null> => {
  const result = await db.client.execute({
    sql: "SELECT origin_issuer FROM oauth_client WHERE slug = ?",
    args: [slug],
  });
  const value = result.rows[0]?.origin_issuer;
  return value == null ? null : String(value);
};

const originKindOf = async (db: SqliteTestFumaDb, slug: string): Promise<string | null> => {
  const result = await db.client.execute({
    sql: "SELECT origin_kind FROM oauth_client WHERE slug = ?",
    args: [slug],
  });
  const value = result.rows[0]?.origin_kind;
  return value == null ? null : String(value);
};

describe("runSqliteOAuthClientGcMigration", () => {
  it.effect("deletes orphaned DCR rows, keeps manual + referenced rows, backfills survivors", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise(() =>
        withDb(async (db) => {
          // Orphaned explicit DCR → delete.
          await insertOAuthClient(db, {
            slug: "dcr-cloudflare-com",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: "dynamic_client_registration",
            originIssuer: "https://cloudflare.com",
          });
          // Orphaned legacy heuristic DCR (null origin) → delete.
          await insertOAuthClient(db, {
            slug: "cloudflare-mcp-2",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: null,
          });
          // Referenced legacy DCR (has a connection) → keep + backfill issuer.
          await insertOAuthClient(db, {
            slug: "cloudflare-mcp",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: null,
            originIssuer: null,
          });
          await insertConnection(db, "cf-main", "cloudflare-mcp");
          // Orphaned manual app → keep (never GC a hand-registered app).
          await insertOAuthClient(db, {
            slug: "my-github-app",
            tokenUrl: "https://github.com/login/oauth/access_token",
            resource: null,
            originKind: "manual",
          });

          const applied = await Effect.runPromise(runSqliteOAuthClientGcMigration(db.client));
          const surviving = await slugs(db);
          const backfilled = await issuerOf(db, "cloudflare-mcp");
          const survivorKind = await originKindOf(db, "cloudflare-mcp");
          const manualKind = await originKindOf(db, "my-github-app");
          const manualIssuer = await issuerOf(db, "my-github-app");
          return {
            applied,
            surviving,
            backfilled,
            survivorKind,
            manualKind,
            manualIssuer,
          };
        }),
      );

      expect(outcome.applied).toEqual({
        deleted: 2,
        backfilled: 1,
        stampedDcr: 1,
        stampedManual: 0,
      });
      // Both orphaned DCR rows gone; the referenced DCR row and the manual app
      // survive.
      expect(outcome.surviving).toEqual(["cloudflare-mcp", "my-github-app"]);
      // The surviving legacy DCR row got its issuer backfilled from token_url's
      // registrable origin, so the per-AS reuse lookup can now key on it, and it
      // is stamped as an explicit DCR row.
      expect(outcome.backfilled).toBe("https://cloudflare.com");
      expect(outcome.survivorKind).toBe("dynamic_client_registration");
      // The manual app was already explicitly stamped, so its stamp is untouched
      // and it never gets an origin_issuer.
      expect(outcome.manualKind).toBe("manual");
      expect(outcome.manualIssuer).toBeNull();
    }),
  );

  it.effect("stamps a legacy null-origin manual survivor as manual with no issuer", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise(() =>
        withDb(async (db) => {
          // Legacy manual row: null origin_kind, auth-code, but NO resource, so
          // the classifier keeps it manual. It must survive, get an explicit
          // `manual` stamp, and NOT receive an origin_issuer.
          await insertOAuthClient(db, {
            slug: "legacy-manual",
            tokenUrl: "https://github.com/login/oauth/access_token",
            resource: null,
            originKind: null,
            originIssuer: null,
          });

          const applied = await Effect.runPromise(runSqliteOAuthClientGcMigration(db.client));
          const surviving = await slugs(db);
          const kind = await originKindOf(db, "legacy-manual");
          const issuer = await issuerOf(db, "legacy-manual");
          return { applied, surviving, kind, issuer };
        }),
      );

      expect(outcome.applied).toEqual({
        deleted: 0,
        backfilled: 0,
        stampedDcr: 0,
        stampedManual: 1,
      });
      expect(outcome.surviving).toEqual(["legacy-manual"]);
      expect(outcome.kind).toBe("manual");
      expect(outcome.issuer).toBeNull();
    }),
  );

  it.effect("is idempotent: a second run deletes nothing more and re-backfills nothing", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise(() =>
        withDb(async (db) => {
          await insertOAuthClient(db, {
            slug: "cloudflare-mcp-2",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: null,
          });
          await insertOAuthClient(db, {
            slug: "cloudflare-mcp",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: null,
            originIssuer: null,
          });
          await insertConnection(db, "cf-main", "cloudflare-mcp");

          const first = await Effect.runPromise(runSqliteOAuthClientGcMigration(db.client));
          const afterFirst = await slugs(db);
          const second = await Effect.runPromise(runSqliteOAuthClientGcMigration(db.client));
          const afterSecond = await slugs(db);
          return { first, afterFirst, second, afterSecond };
        }),
      );

      expect(outcome.first).toEqual({
        deleted: 1,
        backfilled: 1,
        stampedDcr: 1,
        stampedManual: 0,
      });
      // Second pass is a no-op: the orphan is already gone, the survivor's issuer
      // is set, and its origin_kind is stamped (so it is no longer a null-origin
      // candidate for any of delete / backfill / stamp).
      expect(outcome.second).toEqual({
        deleted: 0,
        backfilled: 0,
        stampedDcr: 0,
        stampedManual: 0,
      });
      expect(outcome.afterSecond).toEqual(outcome.afterFirst);
      expect(outcome.afterSecond).toEqual(["cloudflare-mcp"]);
    }),
  );

  it.effect("never deletes a manual app even when it is orphaned and MCP-shaped", () =>
    Effect.gen(function* () {
      const surviving = yield* Effect.promise(() =>
        withDb(async (db) => {
          // Explicit manual origin_kind must shield even an MCP-shaped slug from
          // the heuristic.
          await insertOAuthClient(db, {
            slug: "cloudflare-mcp",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: "manual",
          });
          await Effect.runPromise(runSqliteOAuthClientGcMigration(db.client));
          return slugs(db);
        }),
      );
      expect(surviving).toEqual(["cloudflare-mcp"]);
    }),
  );

  it.effect("no-op on an empty oauth_client table", () =>
    Effect.gen(function* () {
      const applied = yield* Effect.promise(() =>
        withDb((db) => Effect.runPromise(runSqliteOAuthClientGcMigration(db.client))),
      );
      expect(applied).toEqual({ deleted: 0, backfilled: 0, stampedDcr: 0, stampedManual: 0 });
    }),
  );

  it.effect("rolls back the transaction when the migration fiber is interrupted mid-run", () =>
    Effect.gen(function* () {
      const surviving = yield* Effect.promise(() =>
        withDb(async (db) => {
          // Orphaned DCR row: without rollback-on-interrupt, an interruption
          // landing after its DELETE (but before COMMIT) can still leave the
          // transaction committed by a later statement, or the DELETE alone
          // holding an open transaction — either way the row's fate becomes
          // implementation-dependent instead of "the whole run never happened."
          await insertOAuthClient(db, {
            slug: "dcr-cloudflare-com",
            tokenUrl: "https://oauth.cloudflare.com/token",
            resource: "https://cloudflare.example/mcp",
            originKind: "dynamic_client_registration",
            originIssuer: "https://cloudflare.com",
          });

          // Interrupt the migration's fiber right after its DELETE statement
          // executes (i.e. mid-transaction, well before COMMIT), by wrapping
          // the client so the DELETE's returned promise resolves only after
          // the outer fiber has been asked to interrupt.
          const realExecute = db.client.execute.bind(db.client);
          let releaseInterrupt: (() => void) | null = null;
          const interruptSignal = new Promise<void>((resolve) => {
            releaseInterrupt = resolve;
          });
          const wrappedClient: typeof db.client = new Proxy(db.client, {
            get(target, prop, receiver) {
              if (prop !== "execute") return Reflect.get(target, prop, receiver);
              return async (stmt: unknown) => {
                const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
                const result = await realExecute(stmt as never);
                if (typeof sql === "string" && sql.startsWith("DELETE FROM oauth_client")) {
                  // Let the test's interrupt fire, then hand control back so the
                  // fiber observes the interruption as its very next step.
                  releaseInterrupt?.();
                  await new Promise((r) => setTimeout(r, 20));
                }
                return result;
              };
            },
          });

          const fiber = Effect.runFork(runSqliteOAuthClientGcMigration(wrappedClient));
          await interruptSignal;
          await Effect.runPromise(Fiber.interrupt(fiber));

          return slugs(db);
        }),
      );

      // Rolled back: the orphaned row is exactly as it was before the run, not
      // deleted (proving ROLLBACK ran) and not left half-mutated.
      expect(surviving).toEqual(["dcr-cloudflare-com"]);
    }),
  );
});
