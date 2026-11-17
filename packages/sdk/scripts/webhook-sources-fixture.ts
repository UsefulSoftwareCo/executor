/**
 * Local-only probe of the order in which webhook-source reconciliation serves saved intent, and of
 * the lease that keeps two sweeps off one source. It runs the SDK's real `makeWebhookSources` on
 * PGlite in memory. Apps have no deployment, so a served source becomes `needs-setup` without any
 * external call; the stubbed resources only list subscriptions (none) and can hold one source's
 * listing, which keeps that source's lease held by a known sweep. Prints, as JSON, what each case
 * named (`--case NAME`, repeatable, or `--all`) found, for `webhook-source-order.spec.ts` to judge.
 * Each case runs on a database of its own, a copy of one migrated once (`rowsAtOpen` says each
 * opened empty), so no other case's or
 * scenario's sources are ever in its queue; the cases run one after another in one process. The
 * whole run is a few seconds of CPU, so a busy host stays far from the scenario's time limit.
 * Nothing here depends on timing: each case counts sweeps and reads stored state.
 *
 * - `relink-while-new-arrive`: an existing source is linked again while every sweep also finds new
 *   sources. The round in which it is served, or none within the bound.
 * - `configure-while-new-arrive`: the same, saving its intent by configuring it.
 * - `relink-during-lease`: a source is linked again while a sweep holds its lease. Whether a second
 *   sweep claims it meanwhile, and whether it is served again once the first sweep finishes.
 * - `outside-failures-then-new`: eight sources fail outside their attempt at every run, one new
 *   source joins after them. The sweep in which it is served, and how often the failing ones ran.
 * - `relinks-before-each-sweep-then-new`: one new source; before every sweep four older sources are
 *   linked again. The sweep in which the new one is served.
 * - `two-sweeps-race`: two sweeps both read the pending queue before either claims. How many claims.
 * - `setup-completed-while-new-arrive`: a failed source holding a retry time an hour ahead has its
 *   setup completed while every sweep also finds new sources. The round in which it is served.
 * - `waiting-push-after-setup`: a source's setup is completed while the waiting check of that source
 *   runs, between its read and its conditional write. Whether that write pushed the source ahead.
 * - `intent-plan`: 2,000 pending and 2,000 served sources; how the pending query is planned, in
 *   `leaseUntil` order and, for comparison, in `createdAt` order.
 *
 * The clock moves one millisecond at every read, so when each source joined the queue is a fact
 * of the order of the case's writes.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Duration, Effect, Fiber, Layer } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { SqlClient } from "effect/sql";
import { makeExecutorStorage } from "../src/core.ts";
import { database } from "../src/implementation/database.ts";
import { hostCrypto } from "../src/implementation/host-crypto.ts";
import { makeWebhookSources, setupCompleted } from "../src/implementation/webhook-sources.ts";
import { appSlug } from "../src/contracts/app-slug.ts";

const cases = [
  "relink-while-new-arrive",
  "configure-while-new-arrive",
  "relink-during-lease",
  "outside-failures-then-new",
  "relinks-before-each-sweep-then-new",
  "two-sweeps-race",
  "intent-plan",
  "setup-completed-while-new-arrive",
  "waiting-push-after-setup",
] as const;
type Case = (typeof cases)[number];
/** The cases named by `--case` (repeatable), or every case with `--all`, in that order. */
const selected: readonly Case[] = process.argv.includes("--all")
  ? cases
  : process.argv.flatMap((arg, i) => (process.argv[i - 1] === "--case" ? [arg as Case] : []));
for (const name of selected)
  if (!cases.includes(name)) throw new Error(`--case must be one of ${cases.join(", ")}`);
if (selected.length === 0) throw new Error("Name a case with --case, or pass --all.");

/** Sweeps the starvation cases allow before they report that the source was not served. */
const rounds = 20;
/** Sources one sweep serves, as the host's tick asks for. */
const limit = 4;

const owner = "org_fixture";

/**
 * A clock that moves one millisecond at every read, so that two writes always store different
 * times, in the order they were made: when a source joined the queue is a fact of the case, not of
 * how fast it ran.
 */
let ticks = Date.UTC(2026, 10, 16);
const tickingClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => ++ticks,
  currentTimeMillis: Effect.sync(() => ++ticks),
  currentTimeNanosUnsafe: () => BigInt(++ticks) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(++ticks) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(++ticks) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(++ticks) * 1_000_000n),
  sleep: (duration) =>
    Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, Duration.toMillis(duration))),
    ),
};
let serial = 0;
const id = (prefix: string) =>
  `${prefix}_00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

/** One case, on a database of its own: no other case's sources are ever in its queue. */
const program = (name: Case) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    yield* storage.migrate;
    const db = database(storage);
    const crypto = yield* hostCrypto;
    // The provider every fixture account belongs to.
    yield* db.create("providers", {
      id: "prv_fixture",
      definition: {},
    } as never) as Effect.Effect<unknown>;

    /** Apps whose listing dies. */
    const dying = new Set<string>();
    /** How many times each app's subscriptions were listed: once per claimed reconciliation. */
    const listed = new Map<string, number>();
    /** An app whose listing waits for `release`, keeping its source's lease held. */
    let holding:
      | {
          readonly app: string;
          readonly reached: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        }
      | undefined;
    /** Called inside the waiting check, between its read and its conditional write. */
    let duringWaitingCheck: Effect.Effect<void> | undefined;
    let waitingChecks = 0;
    const resources = {
      accountNeedingReconnect: () =>
        Effect.gen(function* () {
          waitingChecks += 1;
          const during = duringWaitingCheck;
          duringWaitingCheck = undefined;
          if (during !== undefined) yield* during;
          // An account must reconnect: the source keeps waiting.
          return "acc_00000000-0000-4000-8000-ffffffffffff";
        }),
      webhooks: {
        list: ({ app }: { readonly app: string }) =>
          Effect.gen(function* () {
            listed.set(app, (listed.get(app) ?? 0) + 1);
            // A defect, outside the reconciliation's attempt: its release puts the source back.
            if (dying.has(app)) return yield* Effect.die(new Error("listing died"));
            if (holding !== undefined && holding.app === app) {
              const held = holding;
              holding = undefined;
              yield* Deferred.succeed(held.reached, undefined);
              yield* Deferred.await(held.release);
            }
            return [];
          }),
      },
    };
    const sources = makeWebhookSources(db, crypto, undefined, resources as never);

    /** An app without a deployment and an account its owner holds. */
    const appWithAccount = Effect.gen(function* () {
      const app = id("app");
      const account = id("acc");
      const createdAt = new Date();
      yield* db.create("apps", {
        id: app,
        code: id("code"),
        repository: null,
        owner,
        name: `Fixture ${serial}`,
        slug: appSlug(`Fixture ${serial}`),
        activeDeployment: null,
        copiedFrom: null,
        createdAt,
      } as never) as Effect.Effect<unknown>;
      yield* db.create("accounts", {
        id: account,
        owner,
        provider: "prv_fixture",
        method: "key",
        label: "fixture",
        encryptedCredentials: new Uint8Array(),
        createdAt,
      } as never) as Effect.Effect<unknown>;
      return { app, account };
    });
    const status = (source: { readonly app: string; readonly account: string }) =>
      (
        db.findFirst("webhookSources", {
          where: (b) =>
            b.and(b("app", "=", source.app as never), b("account", "=", source.account as never)),
        }) as Effect.Effect<unknown>
      ).pipe(Effect.map((row) => (row as { status?: string } | null)?.status));
    const link = (source: { readonly app: string; readonly account: string }) =>
      sources.link({ app: source.app, account: source.account } as never);

    /** One source, served once, then its intent saved again while new sources keep arriving. */
    const whileNewArrive = (
      saveAgain: (source: { app: string; account: string }) => Effect.Effect<unknown, unknown>,
    ) =>
      Effect.gen(function* () {
        const target = yield* appWithAccount;
        yield* link(target);
        yield* sources.tick(limit);
        const before = yield* status(target);
        yield* saveAgain(target);
        const pendingAfterSave = yield* status(target);
        let servedInRound: number | null = null;
        for (let round = 1; round <= rounds && servedInRound === null; round++) {
          // A full sweep's worth of new sources arrives before each sweep.
          for (let i = 0; i < limit; i++) yield* link(yield* appWithAccount);
          yield* sources.tick(limit);
          if ((yield* status(target)) !== "pending") servedInRound = round;
        }
        return { before, pendingAfterSave, servedInRound, rounds, limit };
      });

    switch (name) {
      case "relink-while-new-arrive":
        return yield* whileNewArrive(link);
      case "configure-while-new-arrive":
        return yield* whileNewArrive((source) =>
          Effect.gen(function* () {
            const saved = (yield* db.findFirst("webhookSources", {
              where: (b) =>
                b.and(
                  b("app", "=", source.app as never),
                  b("account", "=", source.account as never),
                ),
            }) as Effect.Effect<unknown>) as { id: string; actor: string | null; revision: number };
            return yield* sources.configureSource({
              app: source.app,
              account: source.account,
              expected: { id: saved.id, actor: saved.actor, revision: saved.revision },
              config: { probe: true },
            } as never);
          }),
        );
      case "outside-failures-then-new": {
        // Eight sources served once, linked again, and each failing outside its attempt from then
        // on; one new source after them. Where it is served, and how often the failing ones run.
        const old = [];
        for (let i = 0; i < 8; i++) old.push(yield* appWithAccount);
        for (const source of old) yield* link(source);
        while ((yield* Effect.forEach(old, status)).some((s) => s === "pending"))
          yield* sources.tick(limit);
        for (const source of old) {
          dying.add(source.app);
          yield* link(source);
        }
        const fresh = yield* appWithAccount;
        yield* link(fresh);
        let servedInSweep: number | null = null;
        for (let sweep = 1; sweep <= rounds && servedInSweep === null; sweep++) {
          // The host runs each sweep on its own; one whose reconciliation died does not stop it.
          yield* Effect.exit(sources.tick(limit));
          if ((yield* status(fresh)) !== "pending") servedInSweep = sweep;
        }
        const claims = old.map((source) => (listed.get(source.app) ?? 0) - 1);
        return { servedInSweep, rounds, limit, maxOldClaims: Math.max(...claims) };
      }
      case "relinks-before-each-sweep-then-new": {
        // Four sources served once; one new source; before every sweep the four are linked again.
        const old = [];
        for (let i = 0; i < limit; i++) old.push(yield* appWithAccount);
        for (const source of old) yield* link(source);
        while ((yield* Effect.forEach(old, status)).some((s) => s === "pending"))
          yield* sources.tick(limit);
        const fresh = yield* appWithAccount;
        yield* link(fresh);
        let servedInSweep: number | null = null;
        for (let sweep = 1; sweep <= rounds && servedInSweep === null; sweep++) {
          for (const source of old) yield* link(source);
          yield* sources.tick(limit);
          if ((yield* status(fresh)) !== "pending") servedInSweep = sweep;
        }
        return { servedInSweep, rounds, limit };
      }
      case "two-sweeps-race": {
        // Two sweeps both read the pending queue before either claims anything: each waits after
        // its read until the other has read too. Then both try to claim the same source.
        const target = yield* appWithAccount;
        yield* link(target);
        const arrived = yield* Deferred.make<void>();
        let reads = 0;
        const barrier = Effect.gen(function* () {
          reads += 1;
          if (reads === 2) yield* Deferred.succeed(arrived, undefined);
          if (reads <= 2) yield* Deferred.await(arrived);
        });
        const racing = new Proxy(db, {
          get: (target, property, receiver) => {
            const value = Reflect.get(target, property, receiver);
            if (property !== "findMany" || typeof value !== "function") return value;
            return (table: string, options: { readonly limit?: number }) => {
              const read = value.call(target, table, options) as Effect.Effect<unknown>;
              return table === "webhookSources" && options?.limit !== undefined
                ? Effect.tap(read, () => barrier)
                : read;
            };
          },
        });
        const racers = makeWebhookSources(racing as never, crypto, undefined, resources as never);
        yield* Effect.all([racers.tick(limit), racers.tick(limit)], { concurrency: "unbounded" });
        return { readsBeforeClaims: reads, claims: listed.get(target.app) ?? 0 };
      }
      case "intent-plan": {
        // 2,000 served sources and, after them, 2,000 pending ones that joined one millisecond apart:
        // how the pending query is planned. One statement writes them, as linking them one by one
        // would, so the case's time does not grow with the rows it needs.
        const base = ticks;
        yield* sql.unsafe(
          `insert into executor_webhook_sources
           (id, app, owner, account, actor, accounts, config, revision, status, failure, reconciled_deployment, lease, lease_until, created_at, retries)
         select 'whs_plan_' || i, 'app_plan_' || i, '${owner}', 'acc_plan_' || i, null, '{}', '{}', 1,
           case when i <= 2000 then 'ready' else 'pending' end, null, null, null,
           to_timestamp((${base} + i) / 1000.0), to_timestamp((${base} + i) / 1000.0), 0
         from generate_series(1, 4000) as i`,
        );
        ticks = base + 4000;
        yield* sql.unsafe("analyze executor_webhook_sources");
        const plan = (order: string) =>
          sql
            .unsafe(
              `explain (analyze, format json) select * from executor_webhook_sources where status = 'pending' and lease is null order by ${order} asc limit ${limit}`,
            )
            .pipe(
              Effect.map((rows) => {
                const root = (rows as unknown as Array<Record<string, unknown>>)[0]?.[
                  "QUERY PLAN"
                ] as Array<{
                  Plan: PlanNode;
                }>;
                const nodes: PlanNode[] = [];
                const walk = (node: PlanNode) => {
                  nodes.push(node);
                  for (const child of node.Plans ?? []) walk(child);
                };
                walk(root[0]!.Plan);
                return {
                  nodes: nodes.map((node) => node["Node Type"]),
                  index:
                    nodes.find((node) => node["Index Name"] !== undefined)?.["Index Name"] ?? null,
                  rowsRead: Math.max(...nodes.map((node) => node["Actual Rows"] ?? 0)),
                  sorted: nodes.some((node) => node["Node Type"] === "Sort"),
                };
              }),
            );
        return {
          pending: 2000,
          leaseUntil: yield* plan("lease_until"),
          createdAt: yield* plan("created_at"),
        };
      }
      case "setup-completed-while-new-arrive": {
        // A source that failed and holds a retry time an hour ahead; a person completes its setup
        // while every sweep also finds a full sweep's worth of new sources.
        const target = yield* appWithAccount;
        yield* link(target);
        yield* sources.tick(limit);
        yield* db.updateMany("webhookSources", {
          where: (b: never) => (b as (...args: unknown[]) => unknown)("app", "=", target.app),
          set: {
            status: "needs-setup",
            failure: "configuration",
            retries: 8,
            leaseUntil: new Date(ticks + 3_600_000),
          },
        } as never) as Effect.Effect<unknown>;
        yield* setupCompleted(db, target as never);
        const pendingAfterSetup = yield* status(target);
        let servedInRound: number | null = null;
        for (let round = 1; round <= rounds && servedInRound === null; round++) {
          for (let i = 0; i < limit; i++) yield* link(yield* appWithAccount);
          yield* sources.tick(limit);
          if ((yield* status(target)) !== "pending") servedInRound = round;
        }
        return { pendingAfterSetup, servedInRound, rounds, limit };
      }
      case "waiting-push-after-setup": {
        // A source waiting on its accounts and due for its check, of an app with a deployment that
        // declares no accounts (so its accounts resolve and the check runs). While the check runs,
        // a person completes the source's setup. The check's own write must not then push it.
        const target = yield* appWithAccount;
        const version = id("dpl");
        const app = (yield* db.findFirst("apps", {
          where: (b: never) => (b as (...args: unknown[]) => unknown)("id", "=", target.app),
        } as never) as Effect.Effect<unknown>) as { code: string };
        yield* db.create("deployments", {
          id: version,
          code: app.code,
          owner,
          build: "bld_00000000-0000-4000-8000-000000000001",
          requirements: { accounts: {} },
          createdAt: new Date(),
          sourceCommit: null,
          fileCount: 1,
        } as never) as Effect.Effect<unknown>;
        yield* db.updateMany("apps", {
          where: (b: never) => (b as (...args: unknown[]) => unknown)("id", "=", target.app),
          set: { activeDeployment: version },
        } as never) as Effect.Effect<unknown>;
        yield* link(target);
        yield* db.updateMany("webhookSources", {
          where: (b: never) => (b as (...args: unknown[]) => unknown)("app", "=", target.app),
          set: {
            status: "needs-setup",
            failure: "accounts",
            retries: 1,
            leaseUntil: new Date(ticks - 1000),
          },
        } as never) as Effect.Effect<unknown>;
        duringWaitingCheck = Effect.orDie(Effect.asVoid(setupCompleted(db, target as never)));
        yield* sources.tick(limit);
        const row = (yield* db.findFirst("webhookSources", {
          where: (b: never) => (b as (...args: unknown[]) => unknown)("app", "=", target.app),
        } as never) as Effect.Effect<unknown>) as {
          status: string;
          retries: number;
          leaseUntil: Date;
        };
        return {
          waitingChecks,
          status: row.status,
          retries: row.retries,
          pushedAhead: row.leaseUntil.getTime() > ticks,
        };
      }
      case "relink-during-lease": {
        const target = yield* appWithAccount;
        yield* link(target);
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        holding = { app: target.app, reached, release };
        // The first sweep claims the source and waits inside its reconciliation, lease held.
        const first = yield* Effect.forkChild(sources.tick(limit));
        yield* Deferred.await(reached);
        // Linked again while that sweep holds the lease.
        yield* link(target);
        // A second sweep meanwhile, with other intent beside it.
        yield* link(yield* appWithAccount);
        yield* sources.tick(limit);
        const claimsWhileHeld = listed.get(target.app) ?? 0;
        // The first sweep finishes; the link it did not see must not be lost.
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(first);
        const afterFirst = yield* status(target);
        yield* sources.tick(limit);
        return {
          claimsWhileHeld,
          afterFirst,
          claimsAfter: listed.get(target.app) ?? 0,
          finalStatus: yield* status(target),
        };
      }
    }
  });

/** One node of a JSON query plan, as `explain (format json)` returns it. */
interface PlanNode {
  readonly "Node Type": string;
  readonly "Index Name"?: string;
  readonly "Actual Rows"?: number;
  readonly Plans?: ReadonlyArray<PlanNode>;
}

/** The schema, migrated once on disk; each case opens a copy of it, a database of its own. */
const migrated = (dataDir: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      yield* storage.migrate;
    }),
  ).pipe(Effect.provide(pgliteLayer({ dataDir })));

/**
 * Rows a case's database holds when the case opens it: zero for a database of its own. Each copy is
 * a separate directory, opened by its own PGlite instance, so no write of one case reaches another.
 */
const rowsAtOpen = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql.unsafe<{ rows: number }>(
    `select ((select count(*) from executor_webhook_sources) + (select count(*) from executor_apps)
       + (select count(*) from executor_accounts) + (select count(*) from executor_providers))::int as rows`,
  );
  return row?.rows ?? -1;
});

/**
 * Each case in turn, each on its own copy of the migrated database, in one process. A case whose
 * database already holds rows is not run: `rowsAtOpen` reports it.
 */
const all = Effect.acquireUseRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "webhook-sources-fixture-"))),
  (directory) =>
    Effect.gen(function* () {
      const template = join(directory, "template");
      yield* migrated(template);
      const cases: Record<string, unknown> = {};
      const opened: Record<string, number> = {};
      for (const name of selected) {
        const dataDir = join(directory, name);
        cpSync(template, dataDir, { recursive: true });
        cases[name] = yield* Effect.scoped(
          Effect.gen(function* () {
            opened[name] = yield* rowsAtOpen;
            return opened[name] === 0 ? yield* program(name) : null;
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              pgliteLayer({ dataDir }),
              NodeCrypto.layerSecureRandom,
              NodeCrypto.layerDigest,
            ),
          ),
        );
      }
      return { rowsAtOpen: opened, cases };
    }),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
);

Effect.runPromise(
  all.pipe(
    Effect.provideService(Clock.Clock, tickingClock),
    Effect.timeout("600 seconds"),
  ) as never,
).then(
  (result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  },
  (error) => {
    console.error(
      String(error).slice(0, 2000),
      JSON.stringify(
        error?.cause ?? error,
        Object.getOwnPropertyNames(error?.cause ?? error),
      ).slice(0, 1500),
    );
    process.exit(1);
  },
);
