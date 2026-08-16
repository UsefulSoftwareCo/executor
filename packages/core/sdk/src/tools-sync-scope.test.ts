import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor } from "./executor";
import type { FumaDb } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";

// A tools READ refreshes stale catalogs before it answers, and each refresh is
// a live upstream handshake. These cases pin the two properties that keep that
// affordable: the refresh sees only connections inside the read's own filter,
// and in steady state it sees nothing at all.

const INTEG_A = IntegrationSlug.make("alpha");
const INTEG_B = IntegrationSlug.make("beta");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({ id: ProviderItemId.make(key), name: key })),
      ),
  };
};

/** A plugin owning two integrations that records every `resolveTools` it is
 *  asked for, as `<integration>/<connection>`. The recorded list IS the cost
 *  a read pays upstream, so the assertions below are about its contents. */
const makeCountingPlugin = () => {
  const resolved: string[] = [];
  let dying = false;
  const plugin = definePlugin(() => ({
    id: "counting" as const,
    credentialProviders: [memoryProvider()],
    storage: () => ({}),
    resolveTools: (input) => {
      const slug = String(input.connection.integration);
      resolved.push(`${slug}/${String(input.connection.name)}`);
      return dying
        ? // oxlint-disable-next-line executor/no-error-constructor -- boundary: a plugin defect IS a raw throw from third-party code, and reproducing it faithfully is the point of this case
          Effect.die(new Error("resolveTools blew up"))
        : Effect.succeed({
            tools: [{ name: ToolName.make(`${slug}_deploy`), description: "deploy" }],
          });
    },
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        Effect.all([
          ctx.core.integrations.register({ slug: INTEG_A, description: "Alpha", config: {} }),
          ctx.core.integrations.register({ slug: INTEG_B, description: "Beta", config: {} }),
        ]),
    }),
  }))();
  return { plugin, resolved, startDying: () => void (dying = true) };
};

/** Wrap a query object so every `connection` read reports its row count. The
 *  refresh's scan is the query this change narrows, and "returned zero rows"
 *  is the only assertion that separates a narrowed scan from one that
 *  over-fetches and then discards. Forwards `withContext` so the executor's
 *  owner-policy binding keeps using the wrapper (as FumaDB requires). */
const observeConnectionReads = (db: FumaDb) => {
  const connectionRowCounts: number[] = [];
  const wrap = (inner: FumaDb): FumaDb =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === "withContext" && typeof value === "function") {
          const withContext = value as (context: unknown) => FumaDb;
          return (context: unknown) => wrap(withContext(context));
        }
        if (prop !== "findMany" || typeof value !== "function") return value;
        const findMany = value as (table: string, options?: unknown) => Promise<readonly unknown[]>;
        return async (table: string, options?: unknown) => {
          const rows = await findMany(table, options);
          if (table === "connection") connectionRowCounts.push(rows.length);
          return rows;
        };
      },
    });
  return { db: wrap(db), connectionRowCounts };
};

const makeHarness = Effect.fnUntraced(function* () {
  const counting = makeCountingPlugin();
  const base = makeTestConfig({ plugins: [counting.plugin] as const });
  const observed = observeConnectionReads(base.db);
  const config = { ...base, db: observed.db };
  const executor = yield* createExecutor(config);
  yield* executor.counting.seed();
  return {
    ...counting,
    executor,
    connectionRowCounts: observed.connectionRowCounts,
    connect: (integration: IntegrationSlug, name: string) =>
      executor.connections.create({
        owner: "org",
        name: ConnectionName.make(name),
        integration,
        template: TEMPLATE,
        value: "secret-token",
      }),
    /** Clear every connection's catalog stamp — the `stale-marked` trigger, as
     *  `connections.markToolsStale` leaves it. */
    markEveryCatalogStale: () =>
      Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b.isNotNull("tools_synced_at"),
          set: { tools_synced_at: null },
        }),
      ),
  };
});

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
        harness.connectionRowCounts.length = 0;

        const tools = yield* harness.executor.tools.list();

        expect(tools.map((tool) => String(tool.name)).sort()).toEqual([
          "alpha_deploy",
          "beta_deploy",
        ]);
        // One scan, and it matched nothing: the steady-state read pays an
        // indexed lookup and no upstream call at all.
        expect(harness.connectionRowCounts).toEqual([0]);
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
        harness.connectionRowCounts.length = 0;

        const tools = yield* harness.executor.tools.list({
          integration: INTEG_A,
          owner: "org",
          connection: ConnectionName.make("second"),
        });

        expect(harness.resolved).toEqual(["alpha/second"]);
        expect(harness.connectionRowCounts).toEqual([1]);
        expect(tools.map((tool) => String(tool.name))).toEqual(["alpha_deploy"]);
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
      }),
    ),
  );
});
