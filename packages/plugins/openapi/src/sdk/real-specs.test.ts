// Parse / extract / preview coverage against a big real-world spec.
// DB-touching behaviour (addSpec, removeSpec, tool registration) moved
// to apps/cloud/src/services/sources-api.node.test.ts — those run
// through the real Drizzle/FumaDB path so storage regressions
// (e.g. a per-row createMany fallback) surface automatically instead
// of needing a dedicated budget assertion.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createExecutor, Scope, ScopeId } from "@executor-js/sdk";
import type { ToolSchemaView } from "@executor-js/sdk/core";
import { makeTestConfig, memorySecretsPlugin } from "@executor-js/sdk/testing";

import type { ParsedDocument } from "./parse";
import { parse } from "./parse";
import { extract } from "./extract";
import { openApiPlugin } from "./plugin";
import { previewSpec as previewSpecRaw } from "./preview";
import type { ExtractionResult } from "./types";

const previewSpec = (input: string) =>
  previewSpecRaw(input).pipe(Effect.provide(FetchHttpClient.layer));

// ---------------------------------------------------------------------------
// Load + parse once, share across tests
// ---------------------------------------------------------------------------

const cloudflareSpecPath = resolve(__dirname, "../../fixtures/cloudflare.json");
const cloudflareSpecText = readFileSync(cloudflareSpecPath, "utf-8");
const vercelSpecPath = resolve(__dirname, "../../fixtures/vercel.json");
const vercelSpecText = readFileSync(vercelSpecPath, "utf-8");

let cachedDoc: ParsedDocument | null = null;
let cachedResult: ExtractionResult | null = null;
let cachedVercelDoc: ParsedDocument | null = null;
let cachedVercelResult: ExtractionResult | null = null;

const getDoc = () =>
  Effect.gen(function* () {
    if (!cachedDoc) cachedDoc = yield* parse(cloudflareSpecText);
    return cachedDoc;
  });

const getResult = () =>
  Effect.gen(function* () {
    if (!cachedResult) {
      const doc = yield* getDoc();
      cachedResult = yield* extract(doc);
    }
    return cachedResult;
  });

const getVercelDoc = () =>
  Effect.gen(function* () {
    if (!cachedVercelDoc) cachedVercelDoc = yield* parse(vercelSpecText);
    return cachedVercelDoc;
  });

const getVercelResult = () =>
  Effect.gen(function* () {
    if (!cachedVercelResult) {
      const doc = yield* getVercelDoc();
      cachedVercelResult = yield* extract(doc);
    }
    return cachedVercelResult;
  });

const TEST_SCOPE = "real-spec-baseline";
const testScope = Scope.make({
  id: ScopeId.make(TEST_SCOPE),
  name: "Real spec baseline",
  createdAt: new Date(0),
});
const schemaCache = new Map<string, ToolSchemaView>();

const getRegisteredToolSchema = (namespace: string, specText: string, toolId: string) =>
  Effect.gen(function* () {
    const cached = schemaCache.get(toolId);
    if (cached) return cached;

    const executor = yield* createExecutor(
      makeTestConfig({
        scopes: [testScope],
        plugins: [openApiPlugin(), memorySecretsPlugin()] as const,
      }),
    );

    yield* executor.openapi.addSpec({
      spec: { kind: "blob", value: specText },
      scope: TEST_SCOPE,
      name: namespace,
      namespace,
      baseUrl: "",
    });

    const schema = yield* executor.tools.schema(toolId);
    expect(schema).not.toBeNull();
    schemaCache.set(toolId, schema!);
    return schema!;
  });

const operationSummary = (result: ExtractionResult, operationId: string) => {
  const op = result.operations.find((candidate) => candidate.operationId === operationId);
  expect(op).toBeDefined();
  return {
    operationId: op!.operationId,
    method: op!.method,
    pathTemplate: op!.pathTemplate,
    tags: op!.tags,
    hasInputSchema: Option.isSome(op!.inputSchema),
    hasOutputSchema: Option.isSome(op!.outputSchema),
  };
};

const extractionSummary = (result: ExtractionResult, selectedOperationIds: readonly string[]) => ({
  title: Option.getOrUndefined(result.title),
  version: Option.getOrUndefined(result.version),
  operationCount: result.operations.length,
  inputSchemaOperationCount: result.operations.filter((op) => Option.isSome(op.inputSchema)).length,
  outputSchemaOperationCount: result.operations.filter((op) => Option.isSome(op.outputSchema))
    .length,
  selectedOperations: selectedOperationIds.map((operationId) =>
    operationSummary(result, operationId),
  ),
});

const schemaPreviewSummary = (schema: ToolSchemaView) => {
  const schemaDefinitions = schema.schemaDefinitions ?? {};
  const typeScriptDefinitions = schema.typeScriptDefinitions ?? {};
  return {
    toolId: schema.id,
    inputSchema: schema.inputSchema,
    outputSchema: schema.outputSchema,
    inputTypeScript: schema.inputTypeScript,
    outputTypeScript: schema.outputTypeScript,
    schemaDefinitionCount: Object.keys(schemaDefinitions).length,
    schemaDefinitionNames: Object.keys(schemaDefinitions).sort(),
    typeScriptDefinitionCount: Object.keys(typeScriptDefinitions).length,
    typeScriptDefinitions,
  };
};

describe("Real specs: Cloudflare API", { timeout: 60_000 }, () => {
  it.effect("parses the full Cloudflare spec", () =>
    Effect.gen(function* () {
      const doc = yield* getDoc();
      expect(doc).toBeDefined();
    }),
  );

  it.effect("extracts operations from the Cloudflare spec", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      expect(Option.getOrElse(result.title, () => "")).toBe("Cloudflare API");
      expect(Option.getOrElse(result.version, () => "")).toBe("4.0.0");
      expect(result.operations.length).toBeGreaterThan(1000);

      for (const op of result.operations) {
        expect(op.operationId).toBeTruthy();
      }

      const validMethods = new Set([
        "get",
        "post",
        "put",
        "delete",
        "patch",
        "head",
        "options",
        "trace",
      ]);
      for (const op of result.operations) {
        expect(validMethods.has(op.method)).toBe(true);
      }

      const zoneOps = result.operations.filter((op) => op.pathTemplate.includes("/zones"));
      expect(zoneOps.length).toBeGreaterThan(0);

      const dnsOps = result.operations.filter((op) => op.pathTemplate.includes("/dns_records"));
      expect(dnsOps.length).toBeGreaterThan(0);
    }),
  );

  it.effect("operations have input schemas", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      const opsWithInput = result.operations.filter((op) => Option.isSome(op.inputSchema));
      expect(opsWithInput.length).toBeGreaterThan(500);
    }),
  );

  it.effect("operations have output schemas", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      const getOps = result.operations.filter((op) => op.method === "get");
      const getOpsWithOutput = getOps.filter((op) => Option.isSome(op.outputSchema));
      expect(getOpsWithOutput.length).toBeGreaterThan(getOps.length / 2);
    }),
  );

  it.effect("previewSpec returns security schemes and header presets", () =>
    Effect.gen(function* () {
      const preview = yield* previewSpec(cloudflareSpecText);

      expect(preview.operationCount).toBeGreaterThan(1000);
      expect(Option.isSome(preview.title)).toBe(true);
      expect(preview.servers.length).toBeGreaterThan(0);

      expect(preview.securitySchemes.length).toBe(4);
      const schemeNames = preview.securitySchemes.map((s) => s.name);
      expect(schemeNames).toContain("api_token");
      expect(schemeNames).toContain("api_key");
      expect(schemeNames).toContain("api_email");

      expect(preview.headerPresets.length).toBeGreaterThan(0);

      const bearerPreset = preview.headerPresets.find((p) => p.label.includes("Bearer"));
      expect(bearerPreset).toBeDefined();
      expect(bearerPreset!.headers["Authorization"]).toBeNull();
      expect(bearerPreset!.secretHeaders).toContain("Authorization");

      const keyEmailPreset = preview.headerPresets.find((p) => p.label.includes("api_email"));
      expect(keyEmailPreset).toBeDefined();
      expect(keyEmailPreset!.headers["X-Auth-Email"]).toBeNull();
      expect(keyEmailPreset!.headers["X-Auth-Key"]).toBeNull();
    }),
  );

  it.effect("preserves extraction baseline for representative operations", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      expect(
        extractionSummary(result, [
          "access-applications-add-an-application",
          "dns-records-for-a-zone-create-dns-record",
          "worker-script-upload-worker-module",
        ]),
      ).toMatchSnapshot();
    }),
  );

  it.effect("preserves registered tool schema and TypeScript output for Access app creation", () =>
    Effect.gen(function* () {
      const schema = yield* getRegisteredToolSchema(
        "cloudflare_api",
        cloudflareSpecText,
        "cloudflare_api.accessApplications.accessApplicationsAddAnApplication",
      );

      expect(schemaPreviewSummary(schema)).toMatchSnapshot();
    }),
  );
});

describe("Real specs: Vercel API", { timeout: 60_000 }, () => {
  it.effect("preserves extraction baseline for representative operations", () =>
    Effect.gen(function* () {
      const result = yield* getVercelResult();

      expect(
        extractionSummary(result, ["createDeployment", "createProject", "updateProject"]),
      ).toMatchSnapshot();
    }),
  );

  it.effect("preserves registered tool schema and TypeScript output for deployment creation", () =>
    Effect.gen(function* () {
      const schema = yield* getRegisteredToolSchema(
        "vercel_api",
        vercelSpecText,
        "vercel_api.deployments.createDeployment",
      );

      expect(schemaPreviewSummary(schema)).toMatchSnapshot();
    }),
  );
});
