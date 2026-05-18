import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { scopedExecutorTable, textColumn } from "./core-schema";
import { ElicitationResponse } from "./elicitation";
import { ToolNotFoundError } from "./errors";
import { createExecutor } from "./executor";
import { ScopeId } from "./ids";
import { definePlugin } from "./plugin";
import { Scope } from "./scope";
import { SourceDetectionResult } from "./types";
import { makeTestConfig, makeTestExecutor } from "./testing";

class TestPluginError extends Data.TaggedError("TestPluginError")<{
  readonly message: string;
}> {}

const testScope = Scope.make({
  id: ScopeId.make("test-scope"),
  name: "test",
  createdAt: new Date(),
});

const txSchema = {
  executor_tx_item: scopedExecutorTable("executor_tx_item", {
    value: textColumn("value"),
  }),
};

type TxItemRow = {
  readonly id: string;
  readonly scope_id: string;
  readonly value: string;
};

const txPlugin = definePlugin(() => ({
  id: "tx" as const,
  schema: txSchema,
  storage: ({ fuma }) => ({
    create: (row: TxItemRow) =>
      fuma.use("tx.item.create", (db) => db.create("executor_tx_item", row)).pipe(Effect.asVoid),
    list: () =>
      fuma.use("tx.item.list", (db) =>
        db.findMany("executor_tx_item", {
          select: ["id", "scope_id", "value"],
          orderBy: ["id", "asc"],
        }),
      ),
  }),
  extension: (ctx) => ({
    seed: (id: string, value: string, scope = String(ctx.scopes[0]!.id)) =>
      ctx.storage.create({ id, scope_id: scope, value }),
    list: () => ctx.storage.list(),
    failAfterPluginAndCoreWrites: () =>
      ctx.transaction(
        Effect.gen(function* () {
          const scope = String(ctx.scopes[0]!.id);
          yield* ctx.storage.create({
            id: "tx-row",
            scope_id: scope,
            value: "created-before-failure",
          });
          yield* ctx.core.sources.register({
            id: "tx-source",
            scope,
            kind: "test",
            name: "Tx Source",
            tools: [{ name: "run", description: "run" }],
          });
          return yield* new TestPluginError({ message: "rollback" });
        }),
      ),
    catchDuplicateCreate: () =>
      Effect.gen(function* () {
        const scope = String(ctx.scopes[0]!.id);
        yield* ctx.storage.create({ id: "dup", scope_id: scope, value: "first" });
        return yield* ctx.storage.create({ id: "dup", scope_id: scope, value: "second" }).pipe(
          Effect.as({ caught: false as const, model: null as string | null }),
          Effect.catchTag("UniqueViolationError", (error) =>
            Effect.succeed({ caught: true as const, model: error.model ?? null }),
          ),
        );
      }),
  }),
}))();

const detector = (id: string, confidence: SourceDetectionResult["confidence"]) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    detect: () =>
      Effect.succeed(
        SourceDetectionResult.make({
          kind: id,
          confidence,
          endpoint: `https://example.com/${id}`,
          name: id,
          namespace: id,
        }),
      ),
  }))();

const schemaProbePlugin = definePlugin(() => ({
  id: "schemaProbe" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    registerSource: () =>
      ctx.transaction(
        Effect.gen(function* () {
          const scope = String(ctx.scopes[0]!.id);
          yield* ctx.core.sources.register({
            id: "schema-source",
            scope,
            kind: "schema",
            name: "Schema Source",
            tools: [
              {
                name: "inspect",
                description: "inspect",
                inputSchema: {
                  type: "object",
                  properties: {
                    pet: { $ref: "#/$defs/Pet" },
                  },
                  required: ["pet"],
                },
                outputSchema: { $ref: "#/$defs/Owner" },
              },
            ],
          });
          yield* ctx.core.definitions.register({
            sourceId: "schema-source",
            scope,
            definitions: {
              Pet: {
                anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }],
              },
              Dog: {
                type: "object",
                properties: {
                  collar: { $ref: "#/$defs/Collar" },
                },
              },
              Cat: {
                type: "object",
                properties: {
                  lives: { type: "number" },
                },
              },
              Collar: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
              Owner: {
                type: "object",
                properties: {
                  pet: { $ref: "#/$defs/Pet" },
                },
              },
              Unused: {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
              },
            },
          });
        }),
      ),
  }),
}))();

const caseSensitiveDynamicPlugin = definePlugin(() => ({
  id: "caseDynamic" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    registerSource: () =>
      ctx.core.sources.register({
        id: "case_source",
        scope: String(ctx.scopes[0]!.id),
        kind: "case",
        name: "Case Source",
        tools: [{ name: "listdashboards", description: "list dashboards" }],
      }),
  }),
  invokeTool: ({ toolRow }) => Effect.succeed({ invokedToolId: toolRow.id }),
}))();

describe("createExecutor", () => {
  it.effect("rolls back plugin and core writes from ctx.transaction failures", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [txPlugin] as const });

      const error = yield* executor.tx.failAfterPluginAndCoreWrites().pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "TestPluginError", message: "rollback" });
      expect(yield* executor.tx.list()).toEqual([]);
      expect(yield* executor.sources.list()).toEqual([]);
      expect(yield* executor.tools.list()).toEqual([]);
    }),
  );

  it.effect("keeps FumaDB unique violations catchable inside plugin code", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [txPlugin] as const });

      const result = yield* executor.tx.catchDuplicateCreate();

      expect(result.caught).toBe(true);
      expect(result.model).toContain("tx.item.create");
    }),
  );

  it.effect("runs plugin and database close hooks", () =>
    Effect.gen(function* () {
      let pluginClosed = false;
      let dbClosed = false;
      const closablePlugin = definePlugin(() => ({
        id: "closable" as const,
        storage: () => ({}),
        close: () =>
          Effect.sync(() => {
            pluginClosed = true;
          }),
      }));
      const config = makeTestConfig({ plugins: [closablePlugin()] as const });
      const executor = yield* createExecutor({
        ...config,
        db: {
          db: config.db,
          close: () =>
            Effect.sync(() => {
              dbClosed = true;
            }),
        },
        onElicitation: "accept-all",
      });

      yield* executor.close();

      expect(pluginClosed).toBe(true);
      expect(dbClosed).toBe(true);
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("orders source detection results by confidence and applies configured bounds", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor({
        ...makeTestConfig({
          plugins: [detector("low", "low"), detector("high", "high"), detector("medium", "medium")],
        }),
        sourceDetection: { maxDetectors: 2, maxResults: 1 },
        onElicitation: "accept-all",
      });

      const results = yield* executor.sources.detect("https://example.com/source");

      expect(results.map((result) => result.kind)).toEqual(["high"]);
    }),
  );

  it.effect("applies hosted outbound policy before source detection plugins run", () =>
    Effect.gen(function* () {
      let called = false;
      const hostedDetector = definePlugin(() => ({
        id: "hosted-detector" as const,
        storage: () => ({}),
        detect: () =>
          Effect.sync(() => {
            called = true;
            return SourceDetectionResult.make({
              kind: "hosted-detector",
              confidence: "high",
              endpoint: "http://127.0.0.1/source",
              name: "hosted detector",
              namespace: "hosted_detector",
            });
          }),
      }));
      const executor = yield* createExecutor({
        scopes: [testScope],
        plugins: [hostedDetector()] as const,
        httpClientLayer: FetchHttpClient.layer,
        onElicitation: "accept-all",
      });

      const results = yield* executor.sources.detect("http://127.0.0.1/source");

      expect(results).toEqual([]);
      expect(called).toBe(false);
    }),
  );

  it.effect("returns schema roots with shared reachable definitions", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [schemaProbePlugin] as const });

      yield* executor.schemaProbe.registerSource();

      const schema = yield* executor.tools.schema("schema-source.inspect");

      expect(schema?.inputSchema).toEqual({
        type: "object",
        properties: {
          pet: { $ref: "#/$defs/Pet" },
        },
        required: ["pet"],
      });
      expect(schema?.outputSchema).toEqual({ $ref: "#/$defs/Owner" });
      expect(schema?.schemaDefinitions).toEqual({
        Cat: expect.any(Object),
        Collar: expect.any(Object),
        Dog: expect.any(Object),
        Owner: expect.any(Object),
        Pet: expect.any(Object),
      });
      expect(schema?.schemaDefinitions).not.toHaveProperty("Unused");
      expect(schema?.inputTypeScript).toContain("pet: Pet");
      expect(schema?.outputTypeScript).toBe("Owner");
      expect(schema?.typeScriptDefinitions).toEqual(
        expect.objectContaining({
          Pet: expect.any(String),
          Owner: expect.any(String),
        }),
      );
    }),
  );

  it.effect("resolves dynamic tool ids case-insensitively before invoking plugins", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [caseSensitiveDynamicPlugin] as const,
      });
      yield* executor.caseDynamic.registerSource();

      const result = yield* executor.tools.invoke("case_source.listDashboards", {});

      expect(result).toEqual({ invokedToolId: "case_source.listdashboards" });
    }),
  );

  it.effect("applies policies after case-insensitive dynamic tool id resolution", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [caseSensitiveDynamicPlugin] as const,
      });
      yield* executor.caseDynamic.registerSource();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "case_source.listdashboards",
        action: "require_approval",
      });
      const calls = { count: 0 };

      const result = yield* executor.tools.invoke(
        "case_source.listDashboards",
        {},
        {
          onElicitation: () =>
            Effect.sync(() => {
              calls.count += 1;
              return ElicitationResponse.make({ action: "accept" });
            }),
        },
      );

      expect(result).toEqual({ invokedToolId: "case_source.listdashboards" });
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("suggests visible tools for missing dynamic tool ids", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [caseSensitiveDynamicPlugin] as const,
      });
      yield* executor.caseDynamic.registerSource();

      const error = yield* executor.tools
        .invoke("case_source.listDashboardsWRONG", {})
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(ToolNotFoundError);
      if (!(error instanceof ToolNotFoundError)) return;
      expect(error.suggestions).toEqual(["case_source.listdashboards"]);
    }),
  );
});
