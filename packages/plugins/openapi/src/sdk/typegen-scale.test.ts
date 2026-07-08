// ---------------------------------------------------------------------------
// `executor generate` at catalog scale: 10,000+ tools across MANY specs.
//
// Real instances reach five-digit tool counts by accumulating integrations,
// not from one giant spec. This suite builds that shape through the real
// ingestion path (addSpec compiles each spec, a connection persists the tool
// rows), mixing:
//   - real service specs served by @executor-js/emulate emulators (github,
//     stripe), exactly what a user adding those integrations gets,
//   - a fleet of synthetic OpenAPI specs topping the catalog up past 10,000
//     tools total.
//
// Then the full generate pipeline runs once over the combined catalog:
//   - `tools.export` returns every tool in one read,
//   - `generateOpenApiSpec` emits the OpenAPI 3.1 document (the primary
//     artifact) and the REAL `openapi-typescript` generator accepts it,
//     proving third-party client generators can consume the output,
//   - `generateToolProxySource` emits the optional TypeScript client and it
//     typechecks under strict mode.
//
// Time budgets are loose regression tripwires (CI machines vary), tight
// enough to catch a regression to per-tool or whole-catalog compilation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import openapiTS, { astToString } from "openapi-typescript";
import * as ts from "typescript";

import { createEmulator, type Emulator, type ServiceName } from "@executor-js/emulate";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
  generateOpenApiSpec,
  generateToolProxySource,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";

const TOTAL_TOOL_TARGET = 10_000;
const SYNTHETIC_SPEC_COUNT = 8;

// Real service specs via local emulators. Two is enough to prove the
// real-spec path; the synthetic fleet carries the volume.
const EMULATED_SERVICES: readonly ServiceName[] = ["github", "stripe"];
const EMULATOR_BASE_PORT = 4720;

// ---------------------------------------------------------------------------
// Synthetic spec fleet
// ---------------------------------------------------------------------------

const buildSyntheticSpec = (specIndex: number, toolCount: number): string => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < toolCount; index += 1) {
    paths[`/resources${index % 50}/r${index}`] = {
      get: {
        operationId: `res.op${index}`,
        summary: `Spec ${specIndex} operation ${index}`,
        parameters: [
          { name: "id", in: "query", required: true, schema: { type: "string" } },
          { name: `filter${index % 250}`, in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    item: { $ref: "#/components/schemas/Item" },
                    page: { $ref: "#/components/schemas/Page" },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: `Scale ${specIndex}`, version: "1.0.0" },
    servers: [{ url: `https://scale${specIndex}.example.test` }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Item: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id"],
        },
        Page: {
          type: "object",
          properties: { cursor: { type: "string" }, hasMore: { type: "boolean" } },
        },
      },
    },
  });
};

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

const typecheck = (source: string, extraSource: string): readonly string[] => {
  const fileName = "generated.ts";
  const fullSource = `${source}\n${extraSource}`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    candidate === fileName
      ? ts.createSourceFile(candidate, fullSource, languageVersion, true)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  host.readFile = (candidate) =>
    candidate === fileName ? fullSource : originalReadFile(candidate);
  host.fileExists = (candidate) => candidate === fileName || originalFileExists(candidate);

  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
};

describe("typed proxy generation at 10k-tool scale (multi-spec)", () => {
  it.effect(
    "ingests emulator + synthetic specs past 10k tools, exports, and generates both artifacts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* createExecutor(
            makeTestConfig({
              plugins: [
                openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
                memoryCredentialsPlugin(),
              ] as const,
            }),
          );

          /** Register a spec and connect it using the first auth template the
           *  spec derives (emulator specs carry real securitySchemes;
           *  synthetic specs derive `apikey-0`). */
          const addAndConnect = (input: {
            slug: string;
            spec: { kind: "url"; url: string } | { kind: "blob"; value: string };
          }) =>
            Effect.gen(function* () {
              const added = yield* executor.openapi.addSpec({
                spec: input.spec,
                slug: input.slug,
              });
              const config = yield* executor.openapi.getConfig(input.slug);
              const template = config?.authenticationTemplate?.[0];
              yield* executor.connections.create({
                owner: "org",
                name: ConnectionName.make("main"),
                integration: IntegrationSlug.make(input.slug),
                template: AuthTemplateSlug.make(template ? String(template.slug) : "apikey-0"),
                value: "scale-token",
              });
              return added.toolCount;
            });

          // Real service specs from local emulators, registered by URL the
          // same way a user pointing Executor at a service would.
          const emulators: Emulator[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => Promise.allSettled(emulators.map((emulator) => emulator.close()))),
          );
          let ingestedTools = 0;
          for (const [index, service] of EMULATED_SERVICES.entries()) {
            const emulator = yield* Effect.promise(() =>
              createEmulator({ service, port: EMULATOR_BASE_PORT + index }),
            );
            emulators.push(emulator);
            const count = yield* addAndConnect({
              slug: `emu_${service}`,
              spec: { kind: "url", url: emulator.openapiUrl },
            });
            expect(count).toBeGreaterThan(0);
            ingestedTools += count;
          }

          // Synthetic fleet tops the catalog up past the target.
          const remaining = TOTAL_TOOL_TARGET - ingestedTools;
          const perSpec = Math.ceil(remaining / SYNTHETIC_SPEC_COUNT);
          for (let specIndex = 0; specIndex < SYNTHETIC_SPEC_COUNT; specIndex += 1) {
            const count = Math.min(perSpec, remaining - specIndex * perSpec);
            if (count <= 0) break;
            ingestedTools += yield* addAndConnect({
              slug: `scale_${specIndex}`,
              spec: { kind: "blob", value: buildSyntheticSpec(specIndex, count) },
            });
          }
          expect(ingestedTools).toBeGreaterThanOrEqual(TOTAL_TOOL_TARGET);

          // One bulk read for the whole catalog.
          const exportStart = performance.now();
          const exported = yield* executor.tools.export();
          const exportMs = performance.now() - exportStart;
          const exportedCount = exported.connections.reduce(
            (sum, connection) => sum + connection.tools.length,
            0,
          );
          expect(exportedCount).toBeGreaterThanOrEqual(TOTAL_TOOL_TARGET);
          expect(exported.connections.length).toBeGreaterThanOrEqual(
            EMULATED_SERVICES.length + SYNTHETIC_SPEC_COUNT,
          );

          // Primary artifact: the OpenAPI document.
          const specStart = performance.now();
          const spec = generateOpenApiSpec(exported, {
            serverUrl: "http://localhost:4788/api",
          });
          const specMs = performance.now() - specStart;
          expect(spec.toolCount).toBe(exportedCount);
          const paths = spec.document.paths as Record<string, unknown>;
          expect(Object.keys(paths).length).toBe(exportedCount);
          // Real-spec tools land beside synthetic ones in the same document.
          expect(
            Object.keys(paths).some((path) => path.startsWith("/tools/invoke/emu_github.")),
          ).toBe(true);
          expect(Object.keys(paths).some((path) => path.startsWith("/tools/invoke/scale_0."))).toBe(
            true,
          );

          // Interop proof: the real openapi-typescript generator consumes the
          // document and emits a paths interface covering the catalog.
          const otsStart = performance.now();
          const ast = yield* Effect.promise(() =>
            openapiTS(
              // oxlint-disable-next-line executor/no-double-cast -- test boundary: openapi-typescript's OpenAPI3 input type vs our Record document; the generator validates it at runtime
              spec.document as unknown as Parameters<typeof openapiTS>[0],
            ),
          );
          const otsSource = astToString(ast);
          const otsMs = performance.now() - otsStart;
          expect(otsSource).toContain("export interface paths");
          const otsPathCount = (otsSource.match(/"\/tools\/invoke\//g) ?? []).length;
          expect(otsPathCount).toBe(exportedCount);

          // Secondary artifact: the self-contained TypeScript client.
          const generateStart = performance.now();
          const generated = generateToolProxySource(exported);
          const generateMs = performance.now() - generateStart;
          expect(generated.toolCount).toBe(exportedCount);

          // Regression tripwires, not benchmarks: whole-catalog single-pass
          // schema compilation measured 30s+ at this size and per-tool passes
          // are far worse; the chunked path runs in well under a second.
          expect(exportMs).toBeLessThan(15_000);
          expect(specMs).toBeLessThan(15_000);
          expect(generateMs).toBeLessThan(30_000);
          expect(otsMs).toBeLessThan(120_000);

          // The full TypeScript client typechecks under strict mode, and a
          // consumer gets real types out of a tool in the middle of the
          // synthetic fleet.
          const diagnostics = typecheck(
            generated.source,
            `
              const client = createExecutorClient();
              async function main() {
                const outcome = await client.scale_3.org.main.resources7.resOp57({ id: "x" });
                if (outcome.ok) {
                  const total: number | undefined = outcome.data.total;
                  const itemId: string | undefined = outcome.data.item?.id;
                  void total;
                  void itemId;
                }
              }
              void main;
            `,
          );
          expect(diagnostics).toEqual([]);
        }),
      ),
    { timeout: 300_000 },
  );
});
