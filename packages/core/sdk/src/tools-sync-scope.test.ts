import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Latch } from "effect";

import { CONNECTION_CATALOG_SCAN_COLUMNS } from "./core-schema";
import { DEFAULT_TOOLS_SYNC_TTL_MS, createExecutor } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolName } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestConfig, memoryCredentialsPlugin } from "./testing";
import type { ToolSyncErrorKind } from "./tool-sync-schedule";

// A tools READ refreshes stale catalogs before it answers, and each refresh is
// a live upstream handshake. These cases pin the three properties that keep
// that affordable and safe: the refresh sees only connections inside the read's
// own filter, in steady state it sees nothing at all, and a wide refresh runs
// its handshakes concurrently WITHOUT letting the persists interleave.

const INTEG_A = IntegrationSlug.make("alpha");
const INTEG_B = IntegrationSlug.make("beta");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** How long any latch in this file is allowed to hold a fiber. Far longer than
 *  a passing run needs (the whole suite is milliseconds), and only ever reached
 *  when the overlap a case is establishing never happened — a sequential
 *  refresh fan-out, or a claim compare-and-set that stopped excluding. Reaching
 *  it lets the fiber through so the case fails on its own assertion instead of
 *  hanging the suite into an opaque timeout with no diff. */
const LATCH_TIMEOUT_MS = 5000;

const withLatchTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(LATCH_TIMEOUT_MS),
      orElse: () => Effect.succeed(undefined),
    }),
  );

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
  let incompleteKind: ToolSyncErrorKind | null | undefined;
  const gate = Latch.makeUnsafe(true);
  const entered = Latch.makeUnsafe(false);

  const plugin = definePlugin(() => ({
    id: "counting" as const,
    storage: () => ({}),
    // Stands in for an MCP server: a catalog only the upstream knows, so the
    // freshness TTL can expire it. Without this the `expired` state is
    // unreachable from these tests, and `expired` is the one state the park
    // gates.
    remoteToolCatalog: true,
    resolveTools: (input) =>
      Effect.gen(function* () {
        const slug = String(input.connection.integration);
        resolved.push(`${slug}/${String(input.connection.name)}`);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        entered.openUnsafe();
        if (holdUntil !== null && inFlight >= holdUntil) gate.openUnsafe();
        yield* withLatchTimeout(gate.await);
        inFlight -= 1;
        if (dying) return yield* Effect.die("resolveTools blew up");
        if (incompleteKind !== undefined) {
          return {
            tools: [],
            incomplete: true,
            incompleteReason: "the fixture upstream refused",
            ...(incompleteKind === null ? {} : { incompleteKind }),
          };
        }
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
      /** The `stale_marked` trigger as a plugin actually fires it (an MCP
       *  `tools/list_changed`, an unknown-tool rejection). */
      markStale: (slug: IntegrationSlug, name: string) =>
        ctx.connections.markToolsStale({
          owner: "org",
          integration: slug,
          name: ConnectionName.make(name),
        }),
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
    /** Make every resolve report a non-authoritative listing. `null` leaves it
     *  unclassified (a plugin that knows it failed but not why); a kind is what
     *  core parks or backs off on. `undefined` restores real listings. */
    resolveIncompleteAs: (kind: ToolSyncErrorKind | null | undefined) => {
      incompleteKind = kind;
    },
    /** Block every resolve until {@link releaseResolves}, so a second read can
     *  be driven all the way through while the first is mid-handshake. */
    blockResolves: () => {
      entered.closeUnsafe();
      gate.closeUnsafe();
    },
    releaseResolves: () => gate.openUnsafe(),
    /** Resolves when a resolve has actually STARTED — the claim is taken by
     *  then, which is the state the contention cases need to observe. */
    awaitResolveStarted: withLatchTimeout(entered.await),
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

        // Cast to the interface's OWN member types, never to a hand-written
        // mirror: the recorder's contract is with `AbstractQuery`, and a
        // re-declared signature is one that silently stops matching it.
        if (prop === "withContext") {
          const withContext = value as NonNullable<FumaDb["withContext"]>;
          return (context: unknown) => wrap(Reflect.apply(withContext, inner, [context]));
        }

        if (prop === "transaction") {
          const transaction = value as FumaDb["transaction"];
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
        const findMany = value as FumaDb["findMany"];
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

/** The projection the catalog-refresh scan is expected to ask for, written out
 *  rather than re-exported from the production constant: comparing the
 *  implementation to itself would catch only the `select` option being deleted,
 *  never the failure the constant's own docstring names — someone adding
 *  `value`, `oauth_state` or `last_health` to it so the every-read scan starts
 *  pulling credential and health JSON. */
const SCAN_PROJECTION = [
  "owner",
  "integration",
  "name",
  "tools_synced_at",
  "tools_stale_token",
  "tools_sync_claim_id",
  "tools_sync_claim_at",
  "tools_sync_failures",
  "tools_sync_retry_at",
  "tools_sync_error_kind",
];

describe("connection catalog scan projection", () => {
  it("is the address plus the sync lifecycle, and nothing else", () => {
    expect([...CONNECTION_CATALOG_SCAN_COLUMNS]).toEqual(SCAN_PROJECTION);
  });
});

const makeHarness = (options?: {
  /** Queue deferred tool-sync batches instead of running them, so a case can
   *  assert what the read did NOT do and then drive the batch itself. */
  readonly collectBackgroundTasks?: boolean;
  /** Replace the seam outright, for the cases about the seam's own contract
   *  rather than about what gets deferred. */
  readonly deferToolSync?: (task: Effect.Effect<void>) => Effect.Effect<void>;
}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const counting = makeCountingPlugin();
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), counting.plugin] as const,
        collectBackgroundTasks: options?.collectBackgroundTasks,
      });
      const observed = observeConnectionReads(config.db);
      const executor = yield* createExecutor({
        ...config,
        db: observed.db,
        ...(options?.deferToolSync === undefined ? {} : { deferToolSync: options.deferToolSync }),
      });
      yield* executor.counting.seed();
      return {
        ...counting,
        executor,
        testDb: config.testDb,
        drainBackgroundTasks: config.drainBackgroundTasks,
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
        /** Clear every connection's catalog stamp, which is the `cold` trigger:
         *  a row with no stamp and no drift mark has never synced. NOT the
         *  drift trigger — `connections.markToolsStale` leaves `tools_synced_at`
         *  alone and writes `tools_stale_token`, which is what
         *  `executor.counting.markStale` drives. Used by the cases that only
         *  need a connection to be due, whatever made it due. */
        clearEveryCatalogStamp: () =>
          Effect.promise(() =>
            observed.db.updateMany("connection", {
              where: (b) => b.isNotNull("tools_synced_at"),
              set: { tools_synced_at: null },
            }),
          ),
        /** Push every catalog past the freshness window, which is the `expired`
         *  trigger: a connection that HAS a working catalog and is only being
         *  asked to re-verify it. Distinct from `cold` in exactly the way the
         *  park cares about, so the two cannot share a helper. */
        expireEveryCatalog: () =>
          Effect.promise(() =>
            observed.db.updateMany("connection", {
              where: (b) => b.isNotNull("tools_synced_at"),
              set: { tools_synced_at: Date.now() - DEFAULT_TOOLS_SYNC_TTL_MS - 1 },
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
        /** The sync lifecycle columns, as persisted. Read straight from the
         *  database rather than through a projection, because "what did the
         *  failed refresh actually write" is the whole question. */
        syncStateOf: (name: string) =>
          Effect.promise(() =>
            observed.db.findFirst("connection", { where: (b) => b("name", "=", name) }),
          ).pipe(
            Effect.flatMap((row) =>
              // A missing row is a defect, not a state. Projecting it into a
              // populated "clean" record is what would let `syncedAt` and
              // `claimId` assert null against an implementation that DELETED
              // the connection rather than one that correctly declined to
              // stamp it.
              row == null
                ? Effect.die(`no connection row named ${name}`)
                : Effect.succeed({
                    syncedAt: row.tools_synced_at == null ? null : Number(row.tools_synced_at),
                    staleToken:
                      row.tools_stale_token == null ? null : String(row.tools_stale_token),
                    failures: row.tools_sync_failures == null ? 0 : Number(row.tools_sync_failures),
                    retryAt:
                      row.tools_sync_retry_at == null ? null : Number(row.tools_sync_retry_at),
                    errorKind: row.tools_sync_error_kind ?? null,
                    claimId: row.tools_sync_claim_id ?? null,
                  }),
            ),
          ),
        /** Re-claim a connection out from under whoever holds it, as a second
         *  Workers isolate does when it observes an expired lease. There is no
         *  in-process seam for this — the row IS the coordination medium. */
        stealClaim: (name: string) =>
          Effect.promise(() =>
            observed.db.updateMany("connection", {
              where: (b) => b("name", "=", name),
              set: { tools_sync_claim_id: "another-isolate", tools_sync_claim_at: Date.now() },
            }),
          ),
        /** Move every backoff window into the past. The ladder's first rung is
         *  the freshness TTL (15 minutes by default), so the alternative is
         *  sleeping through it. */
        elapseEveryBackoff: () =>
          Effect.promise(() =>
            observed.db.updateMany("connection", {
              where: (b) => b.isNotNull("tools_sync_retry_at"),
              set: { tools_sync_retry_at: Date.now() - 1 },
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
        yield* harness.clearEveryCatalogStamp();
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
        yield* harness.clearEveryCatalogStamp();
        harness.resolved.length = 0;
        harness.connectionScans.length = 0;

        const tools = yield* harness.executor.tools.list({
          integration: INTEG_A,
          owner: "org",
          connection: ConnectionName.make("second"),
        });

        expect(harness.resolved).toEqual(["alpha/second"]);
        // One row, and only the columns the refresh actually reads — the
        // connection's address plus its sync lifecycle. The scan runs on every
        // read, so the projection is part of its cost.
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
        yield* harness.clearEveryCatalogStamp();
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
        yield* harness.clearEveryCatalogStamp();
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

// ---------------------------------------------------------------------------
// Sync lifecycle. Concurrent reads have no shared memory (each is potentially
// its own Workers isolate), and a broken upstream has no way of telling us to
// stop calling it. Both are answered by state on the connection row: a refresh
// claim, a failure ladder, and a stamp that is only ever written by a listing
// that actually succeeded.
// ---------------------------------------------------------------------------

describe("tools read catalog refresh lifecycle", () => {
  it.effect("lets exactly one of two concurrent reads dial a drifted connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        // Genuinely drifted, through the path a plugin actually uses: the
        // connection keeps its stamp and carries a `tools_stale_token`.
        yield* harness.executor.counting.markStale(INTEG_A, "main");
        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;
        harness.blockResolves();

        // First reader: forked, and parked inside `resolveTools` — which means
        // it has already taken the claim.
        const first = yield* Effect.forkChild(
          harness.executor.tools.list({ integration: INTEG_A }),
        );
        yield* harness.awaitResolveStarted;

        // Second reader runs to completion against the same drifted connection
        // while the first still holds the claim.
        const second = yield* harness.executor.tools.list({ integration: INTEG_A });

        // One handshake between them, not one each.
        expect(harness.resolved).toEqual(["alpha/main"]);
        // And the loser still ANSWERS — from the stale-but-working catalog.
        expect(second.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);

        harness.releaseResolves();
        const firstTools = yield* Fiber.join(first);
        expect(firstTools.map((tool) => String(tool.name))).toEqual(["alpha_redeploy"]);
        expect(harness.resolved).toEqual(["alpha/main"]);

        // The winner released its lease on the way out.
        expect((yield* harness.syncStateOf("main")).claimId).toBeNull();
      }),
    ),
  );

  it.effect("discards a listing whose lease was taken while it was in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.clearEveryCatalogStamp();
        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;
        harness.blockResolves();

        const slow = yield* Effect.forkChild(harness.executor.tools.list({ integration: INTEG_A }));
        yield* harness.awaitResolveStarted;

        // Another isolate saw the lease expire and re-claimed the connection.
        // The in-flight listing is now the OLDER one, whatever order it lands
        // in, and must not overwrite what the new claimant will write.
        yield* harness.stealClaim("main");
        harness.releaseResolves();

        const tools = yield* Fiber.join(slow);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);

        const state = yield* harness.syncStateOf("main");
        // Nothing of the discarded attempt survives: not the catalog, and not
        // the freshness stamp that would have hidden the drift.
        expect(state.syncedAt).toBeNull();
        expect(state.claimId).toBe("another-isolate");
      }),
    ),
  );

  it.effect("holds a failing connection off until its backoff window elapses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.clearEveryCatalogStamp();
        harness.resolveIncompleteAs(null);
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);

        const afterFailure = yield* harness.syncStateOf("main");
        expect(afterFailure.failures).toBe(1);
        expect(afterFailure.retryAt).not.toBeNull();

        // Inside the window: no upstream call at all, however many reads land.
        yield* harness.executor.tools.list({ integration: INTEG_A });
        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);

        // Past it: one more attempt, and the ladder advances.
        yield* harness.elapseEveryBackoff();
        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main", "alpha/main"]);
        expect((yield* harness.syncStateOf("main")).failures).toBe(2);
      }),
    ),
  );

  it.effect("parks a connection whose credential was refused, and un-parks on refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        // EXPIRED, not cold: the connection has a working catalog and the clock
        // is only asking it to re-verify. That is the one thing the park gates,
        // and the case below pins the other side of the rule.
        yield* harness.expireEveryCatalog();
        harness.resolveIncompleteAs("auth");
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);
        expect((yield* harness.syncStateOf("main")).errorKind).toBe("auth");

        // Parked: not even elapsing the backoff window lets a read dial again.
        // Retrying a rejected credential to re-verify a catalog we can still
        // serve cannot change the verdict, and 401 handshakes were the largest
        // single source of wasted upstream calls.
        yield* harness.elapseEveryBackoff();
        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);

        // An explicit refresh is a human saying "I fixed it": it bypasses the
        // park, dials, and clears the ledger on success.
        harness.resolveIncompleteAs(undefined);
        yield* harness.executor.connections.refresh({
          owner: "org",
          integration: INTEG_A,
          name: ConnectionName.make("main"),
        });
        expect(harness.resolved).toEqual(["alpha/main", "alpha/main"]);

        const recovered = yield* harness.syncStateOf("main");
        expect(recovered.errorKind).toBeNull();
        expect(recovered.failures).toBe(0);
        expect(recovered.syncedAt).not.toBeNull();
      }),
    ),
  );

  it.effect("walks the ladder for a never-synced connection whose credential was refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        // COLD: no catalog at all. Parking this serves nothing, forever, until
        // a human notices — and nothing in this system observes a credential
        // repaired upstream, so the clock has to be what brings it back.
        yield* harness.clearEveryCatalogStamp();
        harness.resolveIncompleteAs("auth");
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);
        expect((yield* harness.syncStateOf("main")).errorKind).toBe("auth");

        // The LADDER holds it off, not the park — so reads inside the window
        // still cost nothing.
        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);

        // Past the rung, a credential fixed upstream is picked up with no human
        // in the loop. Under a park that gated `cold` this read never dials and
        // the connection advertises no tools indefinitely.
        harness.resolveIncompleteAs(undefined);
        yield* harness.elapseEveryBackoff();

        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main", "alpha/main"]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);

        const recovered = yield* harness.syncStateOf("main");
        expect(recovered.errorKind).toBeNull();
        expect(recovered.failures).toBe(0);
        expect(recovered.syncedAt).not.toBeNull();
      }),
    ),
  );

  it.effect("keeps retrying a parked connection whose integration config was revised", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.backdateEveryCatalog();
        // Editing the integration's config is how an `auth` verdict CAUSED by
        // configuration is fixed (the key in the wrong place, the wrong token
        // endpoint), and `integrations.update` is the one invalidation that
        // does not clear the ladder. So this is the case where a park could
        // swallow the repair outright.
        yield* harness.executor.counting.revise(INTEG_A);
        harness.resolveIncompleteAs("auth");
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);
        expect((yield* harness.syncStateOf("main")).errorKind).toBe("auth");

        // The park does NOT apply while the revision is outstanding — but the
        // ladder still does, so a broken config costs one dial per rung rather
        // than one per read.
        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);

        // Past the rung, the fixed config is actually tried. Under a park that
        // ignored the revision this read would never dial and the connection
        // would serve its old catalog forever.
        harness.resolveIncompleteAs(undefined);
        harness.renameToolsTo("redeploy");
        yield* harness.elapseEveryBackoff();

        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main", "alpha/main"]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_redeploy"]);

        const recovered = yield* harness.syncStateOf("main");
        expect(recovered.errorKind).toBeNull();
        expect(recovered.failures).toBe(0);
      }),
    ),
  );

  it.effect("marking a catalog stale records the drift without erasing the stamp", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");

        const synced = yield* harness.syncStateOf("main");
        expect(synced.syncedAt).not.toBeNull();
        expect(synced.staleToken).toBeNull();

        yield* harness.executor.counting.markStale(INTEG_A, "main");

        const drifted = yield* harness.syncStateOf("main");
        // Both facts survive: when it last verified, and that it has since
        // drifted. Clearing the stamp used to conflate this with "never synced".
        expect(drifted.syncedAt).toBe(synced.syncedAt);
        expect(drifted.staleToken).not.toBeNull();

        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;
        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });

        expect(harness.resolved).toEqual(["alpha/main"]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_redeploy"]);

        // The re-list settled the drift by CLEARING the token it observed. It
        // is a compare-and-set, not an unconditional null (the case below is
        // the mark it must not clear), and the clear is what makes the
        // resolution observable rather than inferred from two timestamps that
        // can land in the same millisecond.
        const settled = yield* harness.syncStateOf("main");
        expect(settled.staleToken).toBeNull();
        expect(settled.syncedAt).not.toBeNull();

        // And the connection is genuinely done: the next read does not dial
        // it — and, the property the token encoding exists for, does not even
        // SCAN it. A drift mark nothing ever clears leaves the scan's
        // `tools_stale_token IS NOT NULL` arm matching this row on every read
        // for the rest of its life, which is the steady state PR 1 established
        // and its `candidates` gauge measures.
        harness.resolved.length = 0;
        harness.connectionScans.length = 0;
        yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual([]);
        expect(harness.connectionScans).toEqual([{ rows: 0, select: SCAN_PROJECTION }]);
      }),
    ),
  );

  it.effect("keeps a drift signal that landed while the listing was in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        yield* harness.executor.counting.markStale(INTEG_A, "main");
        const observed = yield* harness.syncStateOf("main");
        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;
        harness.blockResolves();

        // A read is dialing, and parked inside `resolveTools`.
        const listing = yield* Effect.forkChild(
          harness.executor.tools.list({ integration: INTEG_A }),
        );
        yield* harness.awaitResolveStarted;

        // The server sends `tools/list_changed` WHILE we are listing: a
        // different fiber, no coordination with the one in flight, and it
        // describes a tool set this listing cannot have seen.
        yield* harness.executor.counting.markStale(INTEG_A, "main");
        const marked = yield* harness.syncStateOf("main");
        // A FRESH token, which is the entire mechanism: the listing will clear
        // only the token it observed at its start, and this is not that token.
        expect(marked.staleToken).not.toBe(observed.staleToken);

        harness.releaseResolves();
        yield* Fiber.join(listing);

        // The mark survived the success write, verbatim. Nulling
        // `tools_stale_token` unconditionally here is a lost update, and for a
        // plugin with no remote catalog nothing else would ever re-list the
        // connection.
        const state = yield* harness.syncStateOf("main");
        expect(state.staleToken).toBe(marked.staleToken);

        // Which is the fact that matters: the next read dials again.
        harness.renameToolsTo("rerelease");
        harness.resolved.length = 0;
        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(harness.resolved).toEqual(["alpha/main"]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_rerelease"]);

        // And it CONVERGES. That read observed the surviving token and cleared
        // it, so the drift is settled in one extra listing rather than leaving
        // the connection permanently marked — a clear that misses costs one
        // re-list, never a standing scan.
        expect((yield* harness.syncStateOf("main")).staleToken).toBeNull();
      }),
    ),
  );

  it.effect("never advances the sync stamp for a listing that did not succeed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.connect(INTEG_A, "main");
        const synced = yield* harness.syncStateOf("main");

        harness.resolveIncompleteAs("unreachable");
        // One drift signal, then four attempts at it. A failed refresh leaves
        // the drift mark standing (nothing resolved it), so the connection
        // stays due and only the ladder holds it off — which is exactly what
        // `elapseEveryBackoff` steps past.
        yield* harness.executor.counting.markStale(INTEG_A, "main");
        harness.resolved.length = 0;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          yield* harness.elapseEveryBackoff();
          yield* harness.executor.tools.list({ integration: INTEG_A });
        }
        expect(harness.resolved).toHaveLength(4);

        const state = yield* harness.syncStateOf("main");
        // The anti-lying assertion. A month of failed refreshes must leave
        // `tools_synced_at` where the last SUCCESSFUL listing put it, or every
        // freshness decision downstream is made on a fabricated timestamp.
        expect(state.syncedAt).toBe(synced.syncedAt);
        expect(state.failures).toBe(4);
        expect(state.errorKind).toBe("unreachable");
        // The drift mark also stands: only an authoritative listing clears it,
        // and none of these four were one.
        expect(state.staleToken).not.toBeNull();
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Deferred refresh. A TTL `expired` catalog is one nothing has told us is
// wrong — it works, it is merely old — so re-verifying it is background work.
// Every other trigger is somebody reporting that the world changed, and the
// answer this read is about to give is wrong until it runs. These cases pin
// which half is which, and that the background half claims nothing until it
// actually runs.
// ---------------------------------------------------------------------------

describe("tools read deferred catalog refresh", () => {
  it.effect("serves the expired catalog without dialing, and refreshes on the drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ collectBackgroundTasks: true });
        yield* harness.connect(INTEG_A, "main");
        yield* harness.expireEveryCatalog();
        // Make the deferred listing observably different from what is already
        // persisted, so "the drain refreshed it" is distinguishable from "the
        // drain did nothing and the old rows were fine".
        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;

        const served = yield* harness.executor.tools.list({ integration: INTEG_A });

        // The read paid no upstream handshake and answered from the catalog it
        // already had. This is the whole point of the layer.
        expect(harness.resolved).toEqual([]);
        expect(served.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);
        // And it claimed nothing on the way past. The claim belongs to the
        // attempt, so a batch that is enqueued and then never runs (an evicted
        // isolate, a dropped `waitUntil`) strands no lease.
        expect((yield* harness.syncStateOf("main")).claimId).toBeNull();

        yield* harness.drainBackgroundTasks;

        expect(harness.resolved).toEqual(["alpha/main"]);
        const refreshed = yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(refreshed.map((tool) => String(tool.name))).toEqual(["alpha_redeploy"]);
      }),
    ),
  );

  it.effect("still dials a drifted connection inline, seam or no seam", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ collectBackgroundTasks: true });
        yield* harness.connect(INTEG_A, "main");
        // Drifted AND old: `classifyToolSync` ranks the drift signal above the
        // clock, so this is an invalidation, not an expiry, and the read's own
        // correctness depends on it.
        yield* harness.expireEveryCatalog();
        yield* harness.executor.counting.markStale(INTEG_A, "main");
        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;

        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });

        expect(harness.resolved).toEqual(["alpha/main"]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_redeploy"]);
      }),
    ),
  );

  it.effect("caps one read's deferred batch and leaves the rest for the next read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ collectBackgroundTasks: true });
        // One more than the cap, so the boundary is exercised rather than
        // approached. The overflow count itself rides the read's span
        // (`executor.tools.sync.deferred_overflow`); what is asserted here is
        // the behaviour behind it — work is shed, never dropped.
        const names = Array.from({ length: 17 }, (_, index) => `conn${index}`);
        for (const name of names) yield* harness.connect(INTEG_A, name);
        yield* harness.expireEveryCatalog();
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });
        yield* harness.drainBackgroundTasks;

        expect(harness.resolved).toHaveLength(16);

        // The seventeenth is still due — still serving its catalog, and picked
        // up by the very next read.
        const deferredFirst = new Set(harness.resolved);
        harness.resolved.length = 0;
        yield* harness.executor.tools.list({ integration: INTEG_A });
        yield* harness.drainBackgroundTasks;

        const remaining = names
          .map((name) => `alpha/${name}`)
          .filter((address) => !deferredFirst.has(address));
        expect(remaining).toHaveLength(1);
        expect(harness.resolved).toContain(remaining[0]);
      }),
    ),
  );

  it.effect("skips a deferred connection whose lease was taken before the drain ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ collectBackgroundTasks: true });
        yield* harness.connect(INTEG_A, "main");
        yield* harness.expireEveryCatalog();
        harness.renameToolsTo("redeploy");
        harness.resolved.length = 0;

        yield* harness.executor.tools.list({ integration: INTEG_A });

        // Between the enqueue and the drain, another isolate claimed the
        // connection and is listing it. The batch must lose the compare-and-set
        // and stop there — not dial, not fail, not overwrite.
        yield* harness.stealClaim("main");
        yield* harness.drainBackgroundTasks;

        expect(harness.resolved).toEqual([]);
        const state = yield* harness.syncStateOf("main");
        expect(state.claimId).toBe("another-isolate");
        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);
      }),
    ),
  );

  it.effect("answers the read even when the host's defer hook dies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          deferToolSync: () => Effect.die("the host's background queue exploded"),
        });
        yield* harness.connect(INTEG_A, "main");
        yield* harness.expireEveryCatalog();
        harness.resolved.length = 0;

        const tools = yield* harness.executor.tools.list({ integration: INTEG_A });

        // Scheduling is the host's machinery, and a read is not failable by it.
        // Nothing was claimed, so the connection is simply still due.
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);
        expect(harness.resolved).toEqual([]);
        expect((yield* harness.syncStateOf("main")).claimId).toBeNull();
      }),
    ),
  );
});
