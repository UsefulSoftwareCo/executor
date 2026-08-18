import { describe, expect, it } from "@effect/vitest";
import { Effect, Latch } from "effect";

import { CONNECTION_CATALOG_SCAN_COLUMNS } from "./core-schema";
import { createExecutor } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolName } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestConfig, memoryCredentialsPlugin } from "./testing";

// A tools READ refreshes stale catalogs before it answers, and each refresh is
// a live upstream handshake. These cases pin the three properties that keep
// that affordable and safe: the refresh sees only connections inside the read's
// own filter, in steady state it sees nothing at all, and a wide refresh runs
// its handshakes concurrently WITHOUT letting the persists interleave.

const INTEG_A = IntegrationSlug.make("alpha");
const INTEG_B = IntegrationSlug.make("beta");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** A plugin owning two integrations that records every `resolveTools` it is
 *  asked for, as `<integration>/<connection>`. The recorded list IS the cost
 *  a read pays upstream, so most assertions below are about its contents.
 *
 *  `holdResolvesUntil` turns "the handshakes overlapped" from a race the test
 *  hopes for into one it establishes: every resolve blocks on a latch that
 *  only opens once N of them are in flight together. Left disarmed during
 *  setup, where connections are created one at a time and a latch waiting for
 *  a second resolve would simply hang. */
const makeCountingPlugin = () => {
  const resolved: string[] = [];
  let dying = false;
  let toolSuffix = "deploy";
  let holdUntil: number | null = null;
  let inFlight = 0;
  let peakInFlight = 0;
  const gate = Latch.makeUnsafe(true);

  const plugin = definePlugin(() => ({
    id: "counting" as const,
    storage: () => ({}),
    resolveTools: (input) =>
      Effect.gen(function* () {
        const slug = String(input.connection.integration);
        resolved.push(`${slug}/${String(input.connection.name)}`);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        if (holdUntil !== null && inFlight >= holdUntil) gate.openUnsafe();
        yield* gate.await;
        inFlight -= 1;
        if (dying) return yield* Effect.die("resolveTools blew up");
        return {
          tools: [{ name: ToolName.make(`${slug}_${toolSuffix}`), description: toolSuffix }],
        };
      }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        Effect.all([
          ctx.core.integrations.register({ slug: INTEG_A, description: "Alpha", config: {} }),
          ctx.core.integrations.register({ slug: INTEG_B, description: "Beta", config: {} }),
        ]),
      /** The `config_revised` trigger as a plugin actually fires it. The public
       *  `integrations.update` accepts only name/description; `config` — and so
       *  the `config_revised_at` stamp — is on the plugin-facing surface. */
      revise: (slug: IntegrationSlug) =>
        ctx.core.integrations.update(slug, { config: { revision: 2 } }),
    }),
  }))();

  return {
    plugin,
    resolved,
    startDying: () => void (dying = true),
    /** Change what the next resolve returns, so a rebuild that never landed is
     *  distinguishable from one that did. Without this every refresh rewrites
     *  the identical row and a persist that silently failed still looks
     *  correct — the catalog it left behind is the one it would have written. */
    renameToolsTo: (suffix: string) => void (toolSuffix = suffix),
    holdResolvesUntil: (count: number) => {
      holdUntil = count;
      gate.closeUnsafe();
    },
    peakConcurrentResolves: () => peakInFlight,
  };
};

/** Wrap a query object so every `connection` read reports its row count AND its
 *  column projection, and so overlapping transactions are visible.
 *
 *  The refresh's scan is the query this change narrows: "returned zero rows" is
 *  what separates a narrowed scan from one that over-fetches and then discards,
 *  and the recorded `select` is what stops the projection from being deleted
 *  while the row-count assertions stay green.
 *
 *  `transaction` is wrapped too — the wrapped orm is forwarded into the run
 *  callback so reads issued inside a transaction are counted, and the open
 *  count is what proves catalog persists do not interleave. `internal` is
 *  deliberately out of scope: it is the test harness's own lazy-open escape
 *  hatch, so wrapping it would count harness traffic rather than the
 *  executor's. `withContext` is forwarded so the executor's owner-policy
 *  binding keeps using the wrapper (as FumaDB requires). */
const observeConnectionReads = (db: FumaDb) => {
  const connectionScans: { readonly rows: number; readonly select: unknown }[] = [];
  let openTransactions = 0;
  let peakOpenTransactions = 0;

  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;

        if (prop === "withContext") {
          const withContext = value as (context: unknown) => FumaDb;
          return (context: unknown) => wrap(Reflect.apply(withContext, inner, [context]));
        }

        if (prop === "transaction") {
          const transaction = value as (run: (orm: FumaDb) => Promise<unknown>) => Promise<unknown>;
          return (run: (orm: FumaDb) => Promise<unknown>) => {
            openTransactions += 1;
            peakOpenTransactions = Math.max(peakOpenTransactions, openTransactions);
            return Reflect.apply(transaction, inner, [(orm: FumaDb) => run(wrap(orm))]).finally(
              () => {
                openTransactions -= 1;
              },
            );
          };
        }

        if (prop !== "findMany") return value;
        const findMany = value as (
          table: string,
          options?: { readonly select?: unknown },
        ) => Promise<readonly unknown[]>;
        return async (table: string, options?: { readonly select?: unknown }) => {
          const rows = await Reflect.apply(findMany, inner, [table, options]);
          if (table === "connection") {
            connectionScans.push({ rows: rows.length, select: options?.select });
          }
          return rows;
        };
      },
    });

  return {
    db: wrap(db),
    connectionScans,
    peakOpenTransactions: () => peakOpenTransactions,
  };
};

/** The projection the catalog-refresh scan is expected to ask for, as a plain
 *  array so a structural compare against the recorded `select` reads cleanly. */
const SCAN_PROJECTION = [...CONNECTION_CATALOG_SCAN_COLUMNS];

const makeHarness = () =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const counting = makeCountingPlugin();
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), counting.plugin] as const,
      });
      const observed = observeConnectionReads(config.db);
      const executor = yield* createExecutor({ ...config, db: observed.db });
      yield* executor.counting.seed();
      return {
        ...counting,
        executor,
        testDb: config.testDb,
        connectionScans: observed.connectionScans,
        peakOpenTransactions: observed.peakOpenTransactions,
        connect: (integration: IntegrationSlug, name: string) =>
          executor.connections.create({
            owner: "org",
            name: ConnectionName.make(name),
            integration,
            template: TEMPLATE,
            value: "secret-token",
          }),
        /** Clear every connection's catalog stamp — the `stale_marked` trigger,
         *  as `connections.markToolsStale` leaves it. */
        markEveryCatalogStale: () =>
          Effect.promise(() =>
            observed.db.updateMany("connection", {
              where: (b) => b.isNotNull("tools_synced_at"),
              set: { tools_synced_at: null },
            }),
          ),
        /** Push every catalog stamp into the past. The `config_revised` trigger
         *  compares `tools_synced_at` against a stamp taken later in the same
         *  test; on an in-memory database both can land in one millisecond and
         *  the comparison is strict, so the ordering is made explicit here
         *  rather than left to the clock. */
        backdateEveryCatalog: () =>
          Effect.promise(() =>
            observed.db.updateMany("connection", {
              where: (b) => b.isNotNull("tools_synced_at"),
              set: { tools_synced_at: Date.now() - 60_000 },
            }),
          ),
      };
    }),
    ({ executor, testDb }) =>
      executor
        .close()
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => testDb.close()).pipe(Effect.ignore)),
        ),
  );

describe("tools read catalog refresh scope", () => {
  it.effect("refreshes only the integration the read filters to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.connect(INTEG_B, "main");
        yield* harness.markEveryCatalogStale();
        harness.resolved.length = 0;

        const alpha = yield* harness.executor.tools.list({ integration: INTEG_A });

        expect(harness.resolved).toEqual(["alpha/main"]);
        expect(alpha.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);

        const beta = yield* harness.executor.tools.list({ integration: INTEG_B });

        expect(harness.resolved).toEqual(["alpha/main", "beta/main"]);
        expect(beta.map((tool) => String(tool.name))).toEqual(["beta_deploy"]);
      }),
    ),
  );

  it.effect("scans no connection rows once every catalog is fresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.connect(INTEG_B, "main");
        harness.resolved.length = 0;
        harness.connectionScans.length = 0;

        const tools = yield* harness.executor.tools.list();

        expect(tools.map((tool) => String(tool.name)).sort()).toEqual([
          "alpha_deploy",
          "beta_deploy",
        ]);
        // One scan, and it matched nothing: the steady-state read pays an
        // indexed lookup and no upstream call at all.
        expect(harness.connectionScans).toEqual([{ rows: 0, select: SCAN_PROJECTION }]);
        expect(harness.resolved).toEqual([]);
      }),
    ),
  );

  it.effect("narrows the refresh by owner and connection too", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.connect(INTEG_A, "second");
        yield* harness.connect(INTEG_B, "main");
        yield* harness.markEveryCatalogStale();
        harness.resolved.length = 0;
        harness.connectionScans.length = 0;

        const tools = yield* harness.executor.tools.list({
          integration: INTEG_A,
          owner: "org",
          connection: ConnectionName.make("second"),
        });

        expect(harness.resolved).toEqual(["alpha/second"]);
        // One row, and only the four columns the refresh actually reads: the
        // scan runs on every read, so the projection is part of its cost.
        expect(harness.connectionScans).toEqual([{ rows: 1, select: SCAN_PROJECTION }]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);
      }),
    ),
  );

  it.effect("re-resolves only the integration whose config was revised", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.connect(INTEG_B, "main");
        yield* harness.backdateEveryCatalog();
        yield* harness.executor.counting.revise(INTEG_A);
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });

        expect(harness.resolved).toEqual(["alpha/main"]);

        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_B });

        // Beta's catalog is older than alpha's revision stamp, and under one
        // global `staleBefore` that alone made it a candidate. The trigger is
        // per-integration: only the revised integration re-lists.
        expect(harness.resolved).toEqual([]);
      }),
    ),
  );

  it.effect("survives a plugin whose resolveTools dies with a defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.markEveryCatalogStale();
        harness.startDying();
        harness.resolved.length = 0;

        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });

        expect(harness.resolved).toEqual(["alpha/main"]);
        // The refresh died; the read still answers from the stale-but-working
        // catalog rather than failing or returning an empty list.
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);

        const retried = yield* harness.executor.tools.list({ integration: INTEG_A });

        // A failed refresh stamps nothing, so the connection stays stale and
        // the NEXT read attempts it again — best-effort means retried, not
        // abandoned.
        expect(harness.resolved).toEqual(["alpha/main", "alpha/main"]);
        expect(retried.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);
      }),
    ),
  );

  it.effect("persists every catalog when one read refreshes many connections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const names = ["one", "two", "three", "four", "five"];
        for (const name of names) yield* harness.connect(INTEG_A, name);
        // Make the rebuild observably different from what `connect` already
        // persisted, so a refresh whose write never landed is visible.
        harness.renameToolsTo("redeploy");
        yield* harness.markEveryCatalogStale();
        harness.resolved.length = 0;
        // Arm the overlap latch only now: `connect` resolves one connection at
        // a time, and a latch waiting for a second in-flight resolve would
        // never open during setup.
        harness.holdResolvesUntil(2);

        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });

        expect(harness.resolved.slice().sort()).toEqual(names.map((n) => `alpha/${n}`).sort());
        // Every connection's rebuild landed. fumadb runs a SQLite transaction
        // as raw BEGIN/COMMIT on the shared connection, so a second persist
        // entering while the first is open hits "cannot start a transaction
        // within a transaction" and loses its whole rebuild, leaving that
        // connection on the catalog it had before. Without the persist permit
        // this assertion reports four of the five still on `alpha_deploy`.
        expect(
          tools.map((tool) => `${String(tool.connection)}/${String(tool.name)}`).sort(),
        ).toEqual(names.map((n) => `${n}/alpha_redeploy`).sort());

        // The two halves of the invariant: discovery overlapped, persists did
        // not.
        expect(harness.peakConcurrentResolves()).toBeGreaterThan(1);
        expect(harness.peakOpenTransactions()).toBe(1);
      }),
    ),
  );
});
