import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables, createExecutor } from "./executor";
import { createExecutorFumaDb } from "./executor-fuma-db";
import { StorageError, type FumaDb } from "./fuma-runtime";
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
import { createSqliteTestFumaDb } from "./sqlite-test-db";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// Catalog rebuilds on an auto-commit adapter.
//
// Cloudflare D1 has no interactive transactions (`interactiveTransactions:
// false`), so every statement of a catalog rebuild commits on its own and is
// visible to concurrent reads, and a rebuild cut off partway leaves exactly
// the statements that ran. These cases run the rebuild on that adapter shape
// and pin what a reader and a failed rebuild may observe.
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("catalog");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const MAIN = ConnectionName.make("main");

interface CatalogTool {
  readonly name: string;
  readonly description: string;
}

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

// D1 runs a multi-statement bulk write as one native batch RPC and rejects it
// past 32MiB. The harness adapter enforces the same kind of cap, scaled down
// so a test catalog can cross it.
const BULK_WRITE_CAP_BYTES = 2 * 1024 * 1024;

// Hooks the tests arm on the adapter handle the executor writes through.
interface PersistHooks {
  // Pause right after the rebuild's first write to `tool` commits.
  pause: {
    readonly reached: PromiseWithResolvers<void>;
    readonly release: PromiseWithResolvers<void>;
  } | null;
  // Reject every write of new `tool` rows (inserts and upserts; deletes
  // still run), as when a rebuild is cut off before its rows land.
  failToolInserts: boolean;
  // Tables each `deleteMany` targeted.
  readonly deletes: string[];
  // Resolved when a connection's `tools_synced_at` is stamped.
  stamped: PromiseWithResolvers<void> | null;
}

const hookCatalogWrites = (db: FumaDb, hooks: PersistHooks): FumaDb => {
  const toolWrite = async <T>(
    table: string,
    write: () => Promise<T>,
    kind: "insert" | "delete",
    rows: readonly unknown[] = [],
  ): Promise<T> => {
    if (JSON.stringify(rows).length > BULK_WRITE_CAP_BYTES) {
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: fault-injecting FumaDB adapter must reject to emulate D1's batch payload cap
      return Promise.reject(
        new StorageError({
          message: "Bulk write exceeds the batch payload cap.",
          cause: undefined,
        }),
      );
    }
    if (table === "tool" && kind === "insert" && hooks.failToolInserts) {
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: fault-injecting FumaDB adapter must reject to exercise a failed rebuild
      return Promise.reject(
        new StorageError({ message: "Injected tool write failure.", cause: undefined }),
      );
    }
    const result = await write();
    const pause = table === "tool" ? hooks.pause : null;
    if (pause) {
      hooks.pause = null;
      pause.reached.resolve();
      await pause.release.promise;
    }
    return result;
  };
  // The proxy target is an empty stand-in: the ORM handle's own `withContext`
  // is a non-configurable property, which a Proxy over it may not replace.
  const wrap = (source: FumaDb): FumaDb =>
    new Proxy({} as FumaDb, {
      get(_target, property) {
        if (property === "withContext") {
          const withContext = source.withContext?.bind(source);
          return withContext === undefined
            ? undefined
            : (context: unknown) => wrap(withContext(context));
        }
        if (property === "transaction") {
          const transaction: FumaDb["transaction"] = (run) =>
            source.transaction((transactionDb) => run(wrap(transactionDb)));
          return transaction;
        }
        if (property === "createMany") {
          const createMany: FumaDb["createMany"] = (table, rows) =>
            toolWrite(table, () => source.createMany(table, rows), "insert", rows);
          return createMany;
        }
        if (property === "upsertMany") {
          const upsertMany: FumaDb["upsertMany"] = (table, options) =>
            toolWrite(table, () => source.upsertMany(table, options), "insert", options.values);
          return upsertMany;
        }
        if (property === "deleteMany") {
          const deleteMany: FumaDb["deleteMany"] = (table, options) => {
            hooks.deletes.push(table);
            return toolWrite(table, () => source.deleteMany(table, options), "delete");
          };
          return deleteMany;
        }
        if (property === "updateMany") {
          const updateMany: FumaDb["updateMany"] = async (table, options) => {
            await source.updateMany(table, options);
            if (table === "connection" && options.set.tools_synced_at != null) {
              hooks.stamped?.resolve();
            }
          };
          return updateMany;
        }
        const value: unknown = Reflect.get(source, property);
        return typeof value === "function" ? value.bind(source) : value;
      },
    });
  return wrap(db);
};

const makeCatalogExecutor = (options: { readonly toolsSyncGraceMs: number | null }) =>
  Effect.gen(function* () {
    const catalog: { tools: readonly CatalogTool[]; definitions: Record<string, unknown> } = {
      tools: [],
      definitions: {},
    };
    const plugin = definePlugin(() => ({
      id: "catalog" as const,
      credentialProviders: [memoryProvider()],
      storage: () => ({}),
      resolveTools: () =>
        Effect.sync(() => ({
          tools: catalog.tools.map((tool) => ({
            name: ToolName.make(tool.name),
            description: tool.description,
          })),
          definitions: catalog.definitions,
        })),
      invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
      extension: (ctx) => ({
        seed: () =>
          ctx.core.integrations.register({ slug: INTEG, description: "Catalog", config: {} }),
      }),
    }))();

    const config = makeTestConfig({ plugins: [plugin] as const });
    const sqlite = yield* Effect.acquireRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (handle) => Effect.promise(() => handle.close()),
    );
    // The D1 host's adapter options (apps/host-cloudflare/src/db/d1.ts).
    const d1 = createExecutorFumaDb(sqlite.drizzle, {
      tables: collectTables(),
      namespace: "executor_test",
      version: "1.0.0",
      provider: "sqlite",
      interactiveTransactions: false,
      maxBoundParameters: 100,
    });
    const hooks: PersistHooks = { pause: null, failToolInserts: false, deletes: [], stamped: null };
    // Hooks sit under the query context: the context wrapper's own
    // `withContext` is non-configurable, so it cannot be proxied itself.
    const db = withQueryContext(hookCatalogWrites(d1.db as FumaDb, hooks), {
      tenant: "test-tenant",
      subject: "test-subject",
    }) as FumaDb;
    const executor = yield* Effect.acquireRelease(
      createExecutor({
        ...config,
        db,
        toolsSyncGraceMs: options.toolsSyncGraceMs,
      }),
      (instance) => instance.close().pipe(Effect.ignore),
    );

    const markStale = Effect.promise(() =>
      db.updateMany("connection", {
        where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", String(MAIN))),
        set: { tools_synced_at: null },
      }),
    );
    const syncedAt = Effect.promise(() =>
      db.findFirst("connection", {
        where: (b) => b.and(b("integration", "=", String(INTEG)), b("name", "=", String(MAIN))),
      }),
    ).pipe(Effect.map((row) => row?.tools_synced_at ?? null));
    const listTools = executor.tools
      .list({ integration: INTEG })
      .pipe(
        Effect.map((tools) =>
          tools.map((tool) => ({ name: String(tool.name), description: tool.description })),
        ),
      );
    const definitions = Effect.promise(() =>
      db.findMany("definition", { where: (b) => b("integration", "=", String(INTEG)) }),
    ).pipe(
      Effect.map((rows) =>
        Object.fromEntries(rows.map((row) => [String(row.name), row.schema] as const)),
      ),
    );

    const seed = (tools: readonly CatalogTool[], defs: Record<string, unknown>) =>
      Effect.gen(function* () {
        catalog.tools = tools;
        catalog.definitions = defs;
        yield* executor.catalog.seed();
        yield* executor.connections.create({
          owner: "org",
          name: MAIN,
          integration: INTEG,
          template: TEMPLATE,
          value: "secret-token",
        });
      });

    return { catalog, hooks, seed, markStale, syncedAt, listTools, definitions };
  });

const byName = (tools: readonly CatalogTool[]) =>
  [...tools].sort((left, right) => left.name.localeCompare(right.name));

describe("catalog rebuild on an auto-commit adapter", () => {
  it.effect("a read during a rebuild sees the full catalog, and the rebuild lands exactly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // No grace budget: reads answer from the persisted rows immediately
        // while the rebuild runs detached, which is what lets a read land in
        // the middle of it.
        const harness = yield* makeCatalogExecutor({ toolsSyncGraceMs: 0 });
        yield* harness.seed(
          [
            { name: "deploy", description: "deploy v1" },
            { name: "list", description: "list" },
            { name: "legacy", description: "legacy" },
          ],
          { Shared: { type: "string" }, LegacyOnly: { type: "number" } },
        );
        expect(byName(yield* harness.listTools).map((tool) => tool.name)).toEqual([
          "deploy",
          "legacy",
          "list",
        ]);

        // The upstream now drops `legacy`, adds `fresh`, and revises `deploy`
        // and the `Shared` definition.
        harness.catalog.tools = [
          { name: "deploy", description: "deploy v2" },
          { name: "list", description: "list" },
          { name: "fresh", description: "fresh" },
        ];
        harness.catalog.definitions = { Shared: { type: "boolean" }, FreshOnly: { type: "null" } };
        const pause = {
          reached: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        };
        harness.hooks.pause = pause;
        harness.hooks.stamped = Promise.withResolvers<void>();
        yield* harness.markStale;

        const trigger = yield* Effect.forkChild(harness.listTools);
        yield* Effect.promise(() => pause.reached.promise);

        // Mid-rebuild: every tool of the previous catalog is still listed.
        const during = (yield* harness.listTools).map((tool) => tool.name);
        expect(during).toEqual(expect.arrayContaining(["deploy", "legacy", "list"]));

        pause.release.resolve();
        yield* Fiber.join(trigger);
        yield* Effect.promise(() => harness.hooks.stamped!.promise);

        expect(byName(yield* harness.listTools)).toEqual([
          { name: "deploy", description: "deploy v2" },
          { name: "fresh", description: "fresh" },
          { name: "list", description: "list" },
        ]);
        expect(yield* harness.definitions).toEqual({
          Shared: { type: "boolean" },
          FreshOnly: { type: "null" },
        });
        expect(yield* harness.syncedAt).not.toBeNull();
      }),
    ),
  );

  it.effect("rebuilding an unchanged catalog deletes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCatalogExecutor({ toolsSyncGraceMs: null });
        const tools = [
          { name: "deploy", description: "deploy" },
          { name: "list", description: "list" },
        ];
        yield* harness.seed(tools, { Shared: { type: "string" } });

        harness.hooks.deletes.length = 0;
        yield* harness.markStale;
        expect(byName(yield* harness.listTools)).toEqual(tools);

        expect(harness.hooks.deletes).toEqual([]);
        expect(yield* harness.syncedAt).not.toBeNull();
      }),
    ),
  );

  it.effect("a rebuild that fails partway keeps every row and stays stale", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCatalogExecutor({ toolsSyncGraceMs: null });
        const tools = [
          { name: "deploy", description: "deploy" },
          { name: "list", description: "list" },
        ];
        yield* harness.seed(tools, { Shared: { type: "string" } });

        harness.catalog.tools = [{ name: "fresh", description: "fresh" }];
        harness.catalog.definitions = { FreshOnly: { type: "null" } };
        harness.hooks.failToolInserts = true;
        yield* harness.markStale;

        // The failed rebuild is logged and swallowed; the read answers from
        // whatever rows the rebuild left behind.
        expect(byName(yield* harness.listTools)).toEqual(tools);
        expect(yield* harness.syncedAt).toBeNull();
      }),
    ),
  );

  it.effect("a catalog larger than one bulk-write payload still lands in full", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCatalogExecutor({ toolsSyncGraceMs: null });
        yield* harness.seed([{ name: "deploy", description: "deploy" }], {});

        // ~3MB of tool rows: past the adapter's per-call payload cap, the way
        // Cloudflare's own API catalog is past D1's.
        harness.catalog.tools = Array.from({ length: 400 }, (_, index) => ({
          name: `op_${String(index).padStart(3, "0")}`,
          description: "x".repeat(8 * 1024),
        }));
        yield* harness.markStale;

        const tools = yield* harness.listTools;
        expect(tools).toHaveLength(400);
        expect(yield* harness.syncedAt).not.toBeNull();
      }),
    ),
  );
});
