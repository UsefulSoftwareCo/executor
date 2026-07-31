import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "./executor";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolName } from "./ids";
import type { ExecutorOwnerPolicyContext } from "./owner-policy";
import { definePlugin } from "./plugin";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import { resetSubjectTouchCache, touchSubject } from "./subject-registry";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";

// `touchSubject` is the only writer of the `subject` table. Written against the
// real SQLite bring-up (the same statements local/self-host/D1 boot with) so
// the tenant policy, the unique index, and the bigint round-trip are all live.

const TENANT = "t1";
const OTHER_TENANT = "t2";
const THROTTLE_MS = 60_000;

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

// Read the way PR 1.3's readers will: through a tenant-bound query context.
// `last_seen_at` is a bigint column stored as a SQLite blob, so a raw SQL read
// would hand back an unusable buffer — the ORM owns the round-trip.
const scopedTo = (db: SqliteTestFumaDb, tenant: string) =>
  withQueryContext(db.db, {
    tenant,
    subject: null,
  } satisfies ExecutorOwnerPolicyContext);

const storedSubjects = (
  db: SqliteTestFumaDb,
  tenant = TENANT,
): Effect.Effect<readonly { readonly externalId: string; readonly lastSeenMs: number | null }[]> =>
  Effect.promise(async () => {
    const rows = await scopedTo(db, tenant).findMany("subject", {
      orderBy: ["external_id", "asc"],
    });
    return rows.map((row) => ({
      externalId: String(row.external_id),
      lastSeenMs: row.last_seen_at == null ? null : Number(row.last_seen_at),
    }));
  });

// `touchSubject` remembers, per process, which principals it already filed
// inside the throttle window. Every case below reuses the same tenant/principal
// against a FRESH database, so that memory has to be dropped between them or a
// later case would skip the query its assertion depends on.
beforeEach(() => {
  resetSubjectTouchCache();
});

describe("touchSubject", () => {
  it.effect("creates the row on first sight", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const before = Date.now();
        yield* touchSubject(db.db, { tenant: TENANT, externalId: "user_a" });

        const rows = yield* storedSubjects(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.externalId).toBe("user_a");
        // A first sighting IS a sighting: `last_seen_at` is stamped, not left
        // null for the next request to fill in.
        expect(rows[0]?.lastSeenMs).toBeGreaterThanOrEqual(before);
      }),
    ),
  );

  it.effect("leaves last_seen_at alone while the sighting is inside the throttle", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });
        const [first] = yield* storedSubjects(db);

        // The hot path: N requests in quick succession must cost zero writes,
        // so the persisted stamp is unchanged afterwards.
        yield* Effect.forEach([1, 2, 3], () =>
          touchSubject(db.db, {
            tenant: TENANT,
            externalId: "user_a",
            lastSeenThrottleMs: THROTTLE_MS,
          }),
        );

        const rows = yield* storedSubjects(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lastSeenMs).toBe(first?.lastSeenMs);
      }),
    ),
  );

  it.effect("bumps last_seen_at once the sighting falls outside the throttle", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* touchSubject(db.db, { tenant: TENANT, externalId: "user_a" });
        const [first] = yield* storedSubjects(db);

        // Age the row rather than sleeping through the interval. A throttle of
        // zero would pass even if the staleness comparison were inverted; a row
        // aged well past the interval only passes if it reads the right way.
        const stale = (first?.lastSeenMs ?? 0) - 10 * THROTTLE_MS;
        yield* Effect.promise(() =>
          scopedTo(db, TENANT).updateMany("subject", {
            where: (b) => b("external_id", "=", "user_a"),
            set: { last_seen_at: BigInt(stale) },
          }),
        );
        // Backdating the row stands in for elapsed time, and elapsed time ages
        // the process-local sighting memory too — otherwise this would assert
        // against a clock the memory never saw. Expiring it is what the passage
        // of time does; the assertion below is unchanged.
        resetSubjectTouchCache();

        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });

        const rows = yield* storedSubjects(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lastSeenMs).toBeGreaterThan(stale);
      }),
    ),
  );

  it.effect("issues no query at all for a repeat sighting inside the throttle", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // THE regression this guards: the request seam runs `touchSubject` on
        // every HTTP request and MCP session, so a sighting that still costs an
        // indexed read per request adds a round-trip to every request in the
        // product. Dropping the table after the first sighting makes any
        // further query fail loudly — and `touchSubject` swallows storage
        // failures, so a surviving query would be invisible in the row state.
        // Counting statements is the only way to see it.
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });

        let queries = 0;
        const client = db.client as { execute: (...args: never[]) => unknown };
        const execute = client.execute.bind(client) as (...args: never[]) => unknown;
        client.execute = (...args: never[]) => {
          queries += 1;
          return execute(...args);
        };

        yield* Effect.forEach([1, 2, 3], () =>
          touchSubject(db.db, {
            tenant: TENANT,
            externalId: "user_a",
            lastSeenThrottleMs: THROTTLE_MS,
          }),
        );

        client.execute = execute as typeof client.execute;
        expect(queries).toBe(0);
      }),
    ),
  );

  it.effect("re-reads once the remembered sighting ages past the throttle", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // The memory must expire with the throttle, not pin a principal as
        // "recently seen" forever: `last_seen_at` still has to advance for a
        // principal who keeps calling across windows.
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });
        const [first] = yield* storedSubjects(db);

        // A zero throttle makes every remembered sighting instantly stale,
        // which is what a caller crossing the window observes.
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: 0,
        });

        const rows = yield* storedSubjects(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lastSeenMs).toBeGreaterThanOrEqual(first?.lastSeenMs ?? 0);
      }),
    ),
  );

  it.effect("remembers a first sighting per tenant, not per principal", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // One account acting in two orgs is two rows. A memory keyed on the
        // principal alone would file the first tenant and skip the second,
        // losing the row the other tenant's admin view depends on.
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });
        yield* touchSubject(db.db, {
          tenant: OTHER_TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });

        expect((yield* storedSubjects(db, OTHER_TENANT)).map((row) => row.externalId)).toEqual([
          "user_a",
        ]);
      }),
    ),
  );

  it.effect("does not remember a sighting that failed to persist", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // A storage failure is swallowed so the request survives. It must not
        // also be recorded as a successful sighting, or the principal would
        // stay unfiled for a whole throttle window after the fault cleared.
        yield* Effect.promise(() => db.client.execute("DROP TABLE subject"));
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });

        yield* Effect.promise(() =>
          db.client.execute(
            "CREATE TABLE subject (row_id text PRIMARY KEY NOT NULL, tenant text NOT NULL, external_id text NOT NULL, created_at integer NOT NULL, last_seen_at blob, status text)",
          ),
        );
        yield* touchSubject(db.db, {
          tenant: TENANT,
          externalId: "user_a",
          lastSeenThrottleMs: THROTTLE_MS,
        });

        expect((yield* storedSubjects(db)).map((row) => row.externalId)).toEqual(["user_a"]);
      }),
    ),
  );

  it.effect("records nothing for a pure-org executor", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* touchSubject(db.db, { tenant: TENANT, externalId: null });
        expect(yield* storedSubjects(db)).toEqual([]);
      }),
    ),
  );

  it.effect("records the host sentinel subject id", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // apps/local binds every request to the literal subject "local". It is
        // a real principal here, not a placeholder to skip.
        yield* touchSubject(db.db, { tenant: TENANT, externalId: "local" });
        expect((yield* storedSubjects(db)).map((row) => row.externalId)).toEqual(["local"]);
      }),
    ),
  );

  it.effect("files the same principal separately under each tenant", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // The tenant written is always the one bound to the touch, so the
        // tenant policy's create check can never reject it — and one account in
        // two orgs is two rows under two tenants, not a unique-index collision.
        yield* touchSubject(db.db, { tenant: TENANT, externalId: "user_a" });
        yield* touchSubject(db.db, {
          tenant: OTHER_TENANT,
          externalId: "user_a",
        });

        expect((yield* storedSubjects(db, TENANT)).map((row) => row.externalId)).toEqual([
          "user_a",
        ]);
        expect((yield* storedSubjects(db, OTHER_TENANT)).map((row) => row.externalId)).toEqual([
          "user_a",
        ]);
      }),
    ),
  );

  it.effect("survives a storage failure without failing its caller", () =>
    withDb((db) =>
      Effect.gen(function* () {
        // A sighting is bookkeeping. A storage failure must not take down the
        // request that produced it — `touchSubject` logs and returns void.
        // Dropping the table is the real shape of the failure this guards
        // against (a host whose bring-up hasn't reached the new table yet).
        yield* Effect.promise(() => db.client.execute("DROP TABLE subject"));

        yield* touchSubject(db.db, { tenant: TENANT, externalId: "user_a" });
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// The second writer: `connections.create`. The request seam covers every hosted
// call, so this is the belt for a direct SDK/CLI caller that never passes
// through it.
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  storage: () => ({}),
  resolveTools: () => Effect.succeed({ tools: [{ name: ToolName.make("deploy") }] }),
  invokeTool: () => Effect.succeed(null),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Vercel",
        config: {},
      }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), demoPlugin] as const;

const subjectsOf = (
  harness: { readonly config: { readonly db: unknown } },
  tenant: string,
): Effect.Effect<readonly string[]> =>
  Effect.promise(async () => {
    const rows = await withQueryContext(harness.config.db as never, {
      tenant,
      subject: null,
    } satisfies ExecutorOwnerPolicyContext).findMany("subject", {});
    return rows.map((row) => String(row.external_id));
  });

describe("connections.create subject sighting", () => {
  it.effect("records the bound subject", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeTestWorkspaceHarness({
          plugins,
          tenant: TENANT,
        });
        yield* harness.executor.demo.seed();
        yield* harness.executor.connections.create({
          owner: "user",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });

        expect(yield* subjectsOf(harness, TENANT)).toEqual([harness.subject]);
      }),
    ),
  );

  it.effect("records the bound subject even for an org-owned connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The row names the acting principal, not the connection's owner tier:
        // a member who only ever creates org connections still exists.
        const harness = yield* makeTestWorkspaceHarness({
          plugins,
          tenant: TENANT,
        });
        yield* harness.executor.demo.seed();
        yield* harness.executor.connections.create({
          owner: "org",
          name: ConnectionName.make("shared"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });

        expect(yield* subjectsOf(harness, TENANT)).toEqual([harness.subject]);
      }),
    ),
  );

  it.effect("records nothing when the executor has no subject", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeTestWorkspaceHarness({
          plugins,
          tenant: TENANT,
          subject: null,
        });
        yield* harness.executor.demo.seed();
        yield* harness.executor.connections.create({
          owner: "org",
          name: ConnectionName.make("shared"),
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });

        expect(yield* subjectsOf(harness, TENANT)).toEqual([]);
      }),
    ),
  );
});
