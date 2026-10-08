import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExecutor } from "./executor";
import { ConnectionName, IntegrationSlug, NO_AUTH_TEMPLATE, ToolName } from "./ids";
import { definePlugin, type ResolveToolsResult } from "./plugin";
import { makeTestConfig, memoryCredentialsPlugin } from "./testing";

const integration = IntegrationSlug.make("refresh-fixture");
const ref = { owner: "org" as const, integration, name: ConnectionName.make("main") };
const catalog: ResolveToolsResult = {
  tools: [
    {
      name: ToolName.make("list"),
      description: "List items",
      inputSchema: { type: "object", properties: { id: { $ref: "#/$defs/Id" } } },
      outputSchema: { type: "array", items: { type: "string" } },
      annotations: { requiresApproval: false },
    },
    { name: ToolName.make("alpha"), description: "Another tool" },
  ],
  definitions: { Id: { type: "string" } },
};

describe("file-backed catalog refresh", () => {
  it.effect("keeps identical tool and definition rows while reads overlap discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "executor-catalog-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshing = false;
        const fixture = definePlugin(() => ({
          id: "refresh-fixture" as const,
          storage: () => ({}),
          remoteToolCatalog: true,
          describeAuthMethods: () => [
            { id: "none", label: "No authentication", kind: "none", template: "none" },
          ],
          resolveTools: () =>
            Effect.gen(function* () {
              if (refreshing) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return catalog;
            }),
          invokeTool: () => Effect.succeed(null),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: integration,
                description: "Refresh fixture",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({
          dataDir: dir,
          plugins: [memoryCredentialsPlugin(), fixture] as const,
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => config.testDb.close()));
        const executor = yield* createExecutor({ ...config, toolsSyncGraceMs: 0 });
        yield* executor["refresh-fixture"].seed();
        yield* executor.connections.create({ ...ref, template: NO_AUTH_TEMPLATE, inputs: {} });
        const beforeTools = yield* Effect.promise(() => config.db.findMany("tool", {}));
        const beforeDefinitions = yield* Effect.promise(() => config.db.findMany("definition", {}));
        const before = yield* executor.tools.list();
        refreshing = true;
        const refresh = yield* Effect.forkChild(executor.connections.refresh(ref));
        yield* Deferred.await(started);
        const during = yield* executor.tools.list();
        expect(during).toEqual(before);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(refresh);
        expect(yield* executor.tools.list()).toEqual(before);
        expect(yield* Effect.promise(() => config.db.findMany("tool", {}))).toEqual(beforeTools);
        expect(yield* Effect.promise(() => config.db.findMany("definition", {}))).toEqual(
          beforeDefinitions,
        );
      }),
    ),
  );

  it.effect("serves another request while a wave of failed refreshes is still running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "executor-catalog-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const started = yield* Deferred.make<void>();
        const completions: Promise<unknown>[] = [];
        let refreshing = false;
        let discoveries = 0;
        const count = 30;
        const fixture = definePlugin(() => ({
          id: "refresh-fixture" as const,
          storage: () => ({}),
          remoteToolCatalog: true,
          describeAuthMethods: () => [
            { id: "none", label: "No authentication", kind: "none", template: "none" },
          ],
          resolveTools: () =>
            Effect.gen(function* () {
              if (!refreshing) return catalog;
              discoveries += 1;
              yield* Deferred.succeed(started, undefined);
              return { tools: [], incomplete: true, incompleteReason: "fixture offline" };
            }),
          invokeTool: () => Effect.succeed(null),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: integration,
                description: "Refresh fixture",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({
          dataDir: dir,
          plugins: [memoryCredentialsPlugin(), fixture] as const,
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => config.testDb.close()));
        const executor = yield* createExecutor({
          ...config,
          toolsSyncGraceMs: 0,
          waitUntil: (promise) => completions.push(promise),
        });
        yield* executor["refresh-fixture"].seed();
        for (let index = 0; index < count; index += 1) {
          yield* executor.connections.create({
            ...ref,
            name: ConnectionName.make(`connection-${index}`),
            template: NO_AUTH_TEMPLATE,
            inputs: {},
          });
        }
        const before = yield* executor.tools.list();
        yield* Effect.promise(() => Promise.all(completions));
        yield* Effect.promise(() =>
          config.db.updateMany("connection", { set: { tools_synced_at: null } }),
        );
        refreshing = true;
        const read = yield* Effect.forkChild(executor.tools.list());
        yield* Deferred.await(started);
        // Schedule a new incoming request through the event loop, as HTTP does.
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        const observed = discoveries;
        const during = yield* executor.tools.list();
        expect(yield* Fiber.join(read)).toEqual(before);
        expect(observed).toBeLessThan(count);
        expect(during).toEqual(before);
        yield* Effect.promise(() => Promise.all(completions));
        expect(discoveries).toBe(count);
        expect(yield* executor.tools.list()).toEqual(before);
      }),
    ),
  );

  it.effect("an explicit waiter on an incomplete background sync gets the retained schemas", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "executor-catalog-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completions: Promise<unknown>[] = [];
        let refreshing = false;
        const fixture = definePlugin(() => ({
          id: "refresh-fixture" as const,
          storage: () => ({}),
          remoteToolCatalog: true,
          describeAuthMethods: () => [
            { id: "none", label: "No authentication", kind: "none", template: "none" },
          ],
          resolveTools: () =>
            Effect.gen(function* () {
              if (!refreshing) return catalog;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return { tools: [], incomplete: true, incompleteReason: "fixture offline" };
            }),
          invokeTool: () => Effect.succeed(null),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: integration,
                description: "Refresh fixture",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({
          dataDir: dir,
          plugins: [memoryCredentialsPlugin(), fixture] as const,
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => config.testDb.close()));
        const executor = yield* createExecutor({
          ...config,
          toolsSyncGraceMs: 0,
          waitUntil: (promise) => completions.push(promise),
        });
        yield* executor["refresh-fixture"].seed();
        yield* executor.connections.create({ ...ref, template: NO_AUTH_TEMPLATE, inputs: {} });
        yield* Effect.promise(() =>
          config.db.updateMany("connection", { set: { tools_synced_at: null } }),
        );
        refreshing = true;
        const read = yield* Effect.forkChild(executor.tools.list());
        yield* Deferred.await(started);
        const explicit = yield* Effect.forkChild(executor.connections.refresh(ref));
        const during = yield* Fiber.join(read);
        expect(during).toHaveLength(catalog.tools.length);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(explicit);
        const retained = result.find((tool) => String(tool.name) === "list");
        expect(retained?.inputSchema).toEqual(catalog.tools[0]?.inputSchema);
        expect(retained?.outputSchema).toEqual(catalog.tools[0]?.outputSchema);
        expect(retained?.description).toBe("List items");
        yield* Effect.promise(() => Promise.all(completions));
      }),
    ),
  );

  it.effect("replaces changed descriptions, schemas, annotations, definitions and tool sets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "executor-catalog-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        let listing = catalog;
        const fixture = definePlugin(() => ({
          id: "refresh-fixture" as const,
          storage: () => ({}),
          describeAuthMethods: () => [
            { id: "none", label: "No authentication", kind: "none", template: "none" },
          ],
          resolveTools: () => Effect.sync(() => listing),
          invokeTool: () => Effect.succeed(null),
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({
                slug: integration,
                description: "Refresh fixture",
                config: {},
              }),
          }),
        }))();
        const config = makeTestConfig({
          dataDir: dir,
          plugins: [memoryCredentialsPlugin(), fixture] as const,
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => config.testDb.close()));
        const executor = yield* createExecutor(config);
        yield* executor["refresh-fixture"].seed();
        yield* executor.connections.create({ ...ref, template: NO_AUTH_TEMPLATE, inputs: {} });
        const variants: readonly ResolveToolsResult[] = [
          { ...catalog, tools: [{ ...catalog.tools[0]!, description: "Changed description" }] },
          { ...catalog, tools: [{ ...catalog.tools[0]!, inputSchema: { type: "string" } }] },
          { ...catalog, tools: [{ ...catalog.tools[0]!, outputSchema: { type: "number" } }] },
          {
            ...catalog,
            tools: [{ ...catalog.tools[0]!, annotations: { requiresApproval: true } }],
          },
          { ...catalog, definitions: { Id: { type: "number" }, Extra: { type: "boolean" } } },
          { ...catalog, definitions: {} },
          {
            tools: [...catalog.tools, { name: ToolName.make("added"), description: "Added tool" }],
          },
          { tools: [{ name: ToolName.make("replacement"), description: "Replacement tool" }] },
          { tools: [] },
        ];
        for (const variant of variants) {
          listing = variant;
          const refreshed = yield* executor.connections.refresh(ref);
          expect(refreshed.map((tool) => String(tool.name))).toEqual(
            variant.tools.map((tool) => String(tool.name)),
          );
          const tools = yield* Effect.promise(() => config.db.findMany("tool", {}));
          expect(
            tools
              .map((row) => ({
                name: row.name,
                description: row.description,
                input_schema: row.input_schema,
                output_schema: row.output_schema,
                annotations: row.annotations,
              }))
              .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          ).toEqual(
            variant.tools
              .map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                input_schema: tool.inputSchema ?? null,
                output_schema: tool.outputSchema ?? null,
                annotations: tool.annotations ?? null,
              }))
              .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          );
          const definitions = yield* Effect.promise(() => config.db.findMany("definition", {}));
          expect(Object.fromEntries(definitions.map((row) => [row.name, row.schema]))).toEqual(
            variant.definitions ?? {},
          );
        }
      }),
    ),
  );
});
