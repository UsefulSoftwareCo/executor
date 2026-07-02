import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  ToolFileJsonSchema,
  ToolName,
  ToolResult,
  authToolFailure,
  classifyHttpStatus,
  sortHealthCheckCandidatesByIdentity,
  extractIdentity,
  extractResponseFields,
  projectResponseFields,
  type HealthCheckCandidate,
  type HealthCheckResponseField,
  type HealthCheckResult,
  type HealthCheckSpec,
  type IntegrationRecord,
  type PluginCtx,
  type ResolveToolsResult,
  type StorageFailure,
  type ToolDef,
  type ToolInvocationCredential,
} from "@executor-js/sdk/core";

import {
  decodeOpenApiIntegrationConfig,
  renderAuthTemplate,
  requiredTemplateVariables,
  type OpenApiIntegrationConfig,
} from "./config";
import { OpenApiExtractionError, OpenApiParseError } from "./errors";
import {
  buildInputSchema,
  extract,
  streamOperationBindings,
  streamOperationBindingsFromStructure,
} from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { annotationsForOperation, buildRequest, invokeWithLayer, REQUIRE_APPROVAL } from "./invoke";
import { parse, type ParsedDocument } from "./parse";
import { parseEntry, structuralSplit, type KeepPathItem, type SpecStructure } from "./split";
import { type OpenapiStore, type StoredOperation } from "./store";
import { OperationBinding } from "./types";

const STRINGIFIED_BODY_CAP = 1024;
const UpstreamMessageBody = Schema.Struct({ message: Schema.String });
const UpstreamErrorMessageBody = Schema.Struct({ errorMessage: Schema.String });
const UpstreamNestedErrorBody = Schema.Struct({ error: UpstreamMessageBody });
const UpstreamErrorsArrayBody = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      detail: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
});
const UpstreamDescriptionBody = Schema.Struct({
  detail: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const decodeUpstreamMessageBody = Schema.decodeUnknownOption(UpstreamMessageBody);
const decodeUpstreamErrorMessageBody = Schema.decodeUnknownOption(UpstreamErrorMessageBody);
const decodeUpstreamNestedErrorBody = Schema.decodeUnknownOption(UpstreamNestedErrorBody);
const decodeUpstreamErrorsArrayBody = Schema.decodeUnknownOption(UpstreamErrorsArrayBody);
const decodeUpstreamDescriptionBody = Schema.decodeUnknownOption(UpstreamDescriptionBody);

const clampedStringify = (value: unknown): string => {
  let s: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.stringify may throw on cycles; fall back to String() so the upstream body can still be surfaced as ToolError.details fallback text
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > STRINGIFIED_BODY_CAP ? `${s.slice(0, STRINGIFIED_BODY_CAP)}…` : s;
};

const firstNonEmpty = (...values: readonly (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value.length > 0);

export const extractOpenApiUpstreamMessage = (body: unknown, status: number): string => {
  if (typeof body === "string") {
    return body.length > 0 ? body : `Upstream returned HTTP ${status}`;
  }
  const nested = Option.getOrUndefined(decodeUpstreamNestedErrorBody(body));
  const messageBody = Option.getOrUndefined(decodeUpstreamMessageBody(body));
  const errorMessageBody = Option.getOrUndefined(decodeUpstreamErrorMessageBody(body));
  const errorsBody = Option.getOrUndefined(decodeUpstreamErrorsArrayBody(body));
  const descriptionBody = Option.getOrUndefined(decodeUpstreamDescriptionBody(body));
  const arrayMessage = errorsBody?.errors
    .map(
      ({
        detail,
        message: upstreamMessage,
        title,
      }: {
        detail?: string;
        message?: string;
        title?: string;
      }) => firstNonEmpty(detail, upstreamMessage, title),
    )
    .find((message: string | undefined) => message !== undefined);
  const message = firstNonEmpty(
    nested?.error.message,
    messageBody?.message,
    errorMessageBody?.errorMessage,
    arrayMessage,
    descriptionBody?.detail,
    descriptionBody?.title,
    descriptionBody?.description,
  );
  if (message !== undefined) return message;
  if (body !== null && typeof body === "object") {
    return clampedStringify(body);
  }
  return `Upstream returned HTTP ${status}`;
};

const openApiAuthToolFailure = (failure: {
  readonly code: string;
  readonly message: string;
  readonly owner: "org" | "user";
  readonly integration: string;
  readonly connection: string;
  readonly credentialKind: "secret" | "oauth" | "upstream";
  readonly credentialLabel?: string;
  readonly status?: number;
  readonly details?: unknown;
}) =>
  authToolFailure({
    code: failure.code as Parameters<typeof authToolFailure>[0]["code"],
    message: failure.message,
    source: { id: failure.integration, scope: failure.owner },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
    },
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.details !== undefined
      ? {
          upstream: {
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            details: failure.details,
          },
        }
      : {}),
  });

/** Rewrite OpenAPI `#/components/schemas/X` refs to standard `#/$defs/X`. */
export const normalizeOpenApiRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeOpenApiRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) return { ...obj, $ref: `#/$defs/${match[1]}` };
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeOpenApiRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

const toBinding = (def: ToolDefinition): OperationBinding =>
  OperationBinding.make({
    method: def.operation.method,
    servers: def.operation.servers,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
    responseBody: def.operation.responseBody,
  });

const descriptionFor = (def: ToolDefinition): string => {
  const op = def.operation;
  return Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
};

/**
 * Copyable contract appended to the stored description of any tool whose
 * output is a ToolFile. Stored descriptions ride both `search` (the step a
 * model always walks) and `describe.tool`, so baking the emit instruction
 * here puts it in front of the agent before the first call, where the
 * output schema alone (dropped from the hot list projection) cannot.
 */
const FILE_OUTPUT_HINT =
  'Returns a ToolFile: the file bytes already decoded into { _tag: "ToolFile", mimeType, encoding, data, byteLength }. ' +
  "To display or forward it, pass the result's data straight to emit(result.data). " +
  "Do not rebuild the envelope or read upstream fields like size.";

const withFileEmitHint = (description: string, returnsFile: boolean): string =>
  returnsFile ? `${description}\n\n${FILE_OUTPUT_HINT}` : description;

export interface CompiledOpenApiSpec {
  readonly definitions: readonly ToolDefinition[];
  readonly hoistedDefs: Record<string, unknown>;
  readonly title: string | undefined;
  readonly description: string | undefined;
}

export const compileOpenApiDocument = (
  doc: ParsedDocument,
): Effect.Effect<CompiledOpenApiSpec, OpenApiExtractionError> =>
  Effect.gen(function* () {
    const result = yield* extract(doc);
    const hoistedDefs: Record<string, unknown> = {};
    if (doc.components?.schemas) {
      for (const [k, v] of Object.entries(doc.components.schemas)) {
        hoistedDefs[k] = normalizeOpenApiRefs(v);
      }
    }
    return {
      definitions: compileToolDefinitions(result.operations),
      hoistedDefs,
      title: Option.getOrUndefined(result.title),
      description: Option.getOrUndefined(result.description),
    };
  });

export const compileOpenApiSpec = (
  specText: string,
): Effect.Effect<CompiledOpenApiSpec, OpenApiParseError | OpenApiExtractionError> =>
  Effect.gen(function* () {
    const doc = yield* parse(specText);
    return yield* compileOpenApiDocument(doc);
  });

export const openApiToolDefsFromCompiled = (compiled: CompiledOpenApiSpec): readonly ToolDef[] =>
  compiled.definitions.map((def): ToolDef => {
    const returnsFile = Option.match(def.operation.responseBody, {
      onNone: () => false,
      onSome: (responseBody) => Option.isSome(responseBody.fileHint),
    });
    return {
      name: ToolName.make(def.toolPath),
      description: withFileEmitHint(descriptionFor(def), returnsFile),
      inputSchema: normalizeOpenApiRefs(Option.getOrUndefined(def.operation.inputSchema)),
      outputSchema: returnsFile
        ? ToolFileJsonSchema
        : normalizeOpenApiRefs(Option.getOrUndefined(def.operation.outputSchema)),
      annotations: annotationsForOperation(def.operation.method, def.operation.pathTemplate),
    };
  });

export const openApiStoredOperationsFromCompiled = (
  integration: string,
  compiled: CompiledOpenApiSpec,
): readonly StoredOperation[] =>
  compiled.definitions.map((def) => ({
    integration,
    toolName: def.toolPath,
    binding: toBinding(def),
    description: descriptionFor(def),
  }));

/**
 * Serialize a document's `components.schemas` into the content-addressed defs
 * blob JSON (`{ "<Name>": <normalized schema>, ... }`), one schema at a time.
 * Normalizing + stringifying per entry keeps the whole normalized definition
 * tree from ever being co-resident with the parsed document, so the streaming
 * add path's peak stays near parse level. The serve path JSON-parses this blob
 * to rebuild the shared `definitions` instead of re-parsing the spec.
 */
export const buildDefsJson = (doc: ParsedDocument): string => {
  const schemas = doc.components?.schemas;
  if (!schemas) return "{}";
  let json = "{";
  let first = true;
  for (const [name, schema] of Object.entries(schemas)) {
    const serialized = JSON.stringify(normalizeOpenApiRefs(schema));
    if (serialized === undefined) continue;
    json += `${first ? "" : ","}${JSON.stringify(name)}:${serialized}`;
    first = false;
  }
  return `${json}}`;
};

/**
 * Streaming twin of `buildDefsJson`: serialize the content-addressed defs blob
 * from a `SpecStructure` by parsing each `components.schemas` entry in isolation
 * (indent-4 range) rather than from a whole-document parse. Used by the fully
 * streaming add path so the 37MB Microsoft Graph spec never builds its
 * ~300MB tree. The blob carries *all* source schemas (it is shared across every
 * tenant/selection on the same spec hash); extra unreferenced `$defs` are
 * harmless. Like `buildDefsJson`, normalizing + stringifying per entry keeps the
 * whole normalized tree from being co-resident with any parsed schema, and the
 * ConsString accumulation avoids the join-doubling of an array build.
 */
export const buildDefsJsonStreaming = (structure: SpecStructure): string => {
  let json = "{";
  let first = true;
  for (const range of structure.schemas) {
    const entry = parseEntry(structure.text, range, 4);
    if (!entry) continue;
    const [name, schema] = entry;
    const serialized = JSON.stringify(normalizeOpenApiRefs(schema));
    if (serialized === undefined) continue;
    json += `${first ? "" : ","}${JSON.stringify(name)}:${serialized}`;
    first = false;
  }
  return `${json}}`;
};

const DefsJson = Schema.Record(Schema.String, Schema.Unknown);
/** Decode the content-addressed defs blob back into the shared `definitions`
 *  map. Returns `None` on a corrupt/non-object blob so the serve path falls
 *  back to the spec re-parse rather than failing `tools/list`. */
const decodeDefsJson = Schema.decodeUnknownOption(Schema.fromJsonString(DefsJson));

/** Rebuild a tool def from a stored operation binding, no spec parse. Mirrors
 *  `openApiToolDefsFromCompiled` but sources its schemas from the persisted
 *  binding (params/body/response carry `$ref`s into the shared defs blob). The
 *  file-emit hint is applied here, at the same ToolDef projection step the
 *  re-parse path applies it, so a file-returning op carries the contract
 *  whether it is served fast (from the binding) or via the spec fallback. */
const toolDefFromStoredOperation = (op: StoredOperation): ToolDef => {
  const binding = op.binding;
  const returnsFile = Option.match(binding.responseBody, {
    onNone: () => false,
    onSome: (responseBody) => Option.isSome(responseBody.fileHint),
  });
  return {
    name: ToolName.make(op.toolName),
    description: withFileEmitHint(
      op.description ?? `${binding.method.toUpperCase()} ${binding.pathTemplate}`,
      returnsFile,
    ),
    inputSchema: normalizeOpenApiRefs(
      buildInputSchema(
        binding.parameters,
        Option.getOrUndefined(binding.requestBody),
        binding.servers ?? [],
      ),
    ),
    outputSchema: returnsFile
      ? ToolFileJsonSchema
      : Option.match(binding.responseBody, {
          onNone: () => undefined,
          onSome: (responseBody) =>
            normalizeOpenApiRefs(Option.getOrUndefined(responseBody.schema)),
        }),
    annotations: annotationsForOperation(binding.method, binding.pathTemplate),
  };
};

export interface OpenApiPersistResult {
  readonly toolCount: number;
  readonly toolNames: readonly string[];
}

/**
 * Compile a parsed document straight to persisted operation bindings, streaming
 * in bounded chunks so a huge spec's bindings are never all co-resident with
 * the parsed tree. This is the memory-safe replacement for
 * `compileOpenApiDocument` + `openApiStoredOperationsFromCompiled` + `putOperations`
 * on the add/update path: it skips per-op input/output schema assembly (the
 * serve path rebuilds those on demand from the bindings). Clears existing
 * operations first, then appends each chunk. When `specHash` is given, also
 * stream-serializes the document's `#/$defs/*` into the content-addressed defs
 * blob so the serve path can resolve the shared `definitions` without
 * re-parsing the spec.
 */
export const compileAndPersistOpenApiOperations = ({
  doc,
  integration,
  storage,
  specHash,
  chunkSize,
}: {
  readonly doc: ParsedDocument;
  readonly integration: string;
  readonly storage: OpenapiStore;
  readonly specHash?: string;
  readonly chunkSize?: number;
}): Effect.Effect<OpenApiPersistResult, OpenApiExtractionError | StorageFailure> =>
  Effect.gen(function* () {
    yield* storage.removeOperations(integration);
    const result = yield* streamOperationBindings(doc, chunkSize ?? 500, (chunk) =>
      storage.appendOperations(
        integration,
        chunk.map((item) => ({
          integration,
          toolName: item.toolName,
          binding: item.binding,
          description: item.description,
        })),
      ),
    );
    if (specHash != null) {
      yield* storage.putDefs(specHash, buildDefsJson(doc));
    }
    return result;
  });

/** Parse spec text, then stream-compile + persist its bindings (and, when
 *  `specHash` is given, the content-addressed defs blob). */
export const compileAndPersistOpenApiSpec = ({
  specText,
  integration,
  storage,
  specHash,
  chunkSize,
}: {
  readonly specText: string;
  readonly integration: string;
  readonly storage: OpenapiStore;
  readonly specHash?: string;
  readonly chunkSize?: number;
}): Effect.Effect<
  OpenApiPersistResult,
  OpenApiParseError | OpenApiExtractionError | StorageFailure
> =>
  Effect.gen(function* () {
    const doc = yield* parse(specText);
    return yield* compileAndPersistOpenApiOperations({
      doc,
      integration,
      storage,
      specHash,
      chunkSize,
    });
  });

/**
 * Fully streaming add/update path: compile + persist operation bindings (and the
 * content-addressed defs blob) straight from spec *text*, without ever parsing
 * the whole document. The text is structurally split, then each path-item and
 * each schema is parsed in isolation and discarded, so peak memory stays near
 * one item rather than the ~300MB whole-tree parse that OOMs a 128MB Workers
 * isolate on the 37MB Microsoft Graph spec.
 *
 * There is deliberately no whole-parse fallback: a spec that does not present
 * the streamable block-YAML profile (no top-level `paths:` block) is a hard
 * `OpenApiExtractionError`, because the fallback is exactly the OOM this path
 * exists to avoid. `keepPathItem` optionally filters/trims path-items (the
 * Microsoft Graph scope selection), so the same primitive serves a full-spec
 * compile and a selection identically.
 */
export const compileAndPersistOpenApiSpecStreaming = ({
  specText,
  integration,
  storage,
  specHash,
  chunkSize,
  keepPathItem,
}: {
  readonly specText: string;
  readonly integration: string;
  readonly storage: OpenapiStore;
  readonly specHash?: string;
  readonly chunkSize?: number;
  readonly keepPathItem?: KeepPathItem;
}): Effect.Effect<OpenApiPersistResult, OpenApiExtractionError | StorageFailure> =>
  Effect.gen(function* () {
    const structure = structuralSplit(specText);
    if (!structure) {
      return yield* new OpenApiExtractionError({
        message:
          "OpenAPI spec is not in the streamable block-YAML profile (no top-level `paths:` block); cannot stream-compile a spec this large in-band.",
      });
    }
    yield* storage.removeOperations(integration);
    const result = yield* streamOperationBindingsFromStructure(
      structure,
      { chunkSize: chunkSize ?? 500, keepPathItem },
      (chunk) =>
        storage.appendOperations(
          integration,
          chunk.map((item) => ({
            integration,
            toolName: item.toolName,
            binding: item.binding,
            description: item.description,
          })),
        ),
    );
    if (specHash != null) {
      yield* storage.putDefs(specHash, buildDefsJsonStreaming(structure));
    }
    return result;
  });

export const loadOpenApiSpecText = (
  storage: OpenapiStore,
  config: OpenApiIntegrationConfig,
): Effect.Effect<string | null, StorageFailure> =>
  config.specHash != null ? storage.getSpec(config.specHash) : Effect.succeed(null);

/**
 * Resolve the tool defs + shared definitions for a connection refresh
 * (`tools/list`). Fast path: serve from the persisted operation bindings plus
 * the content-addressed defs blob, rebuilding each tool's input/output schema
 * on demand, so a 37MB spec is never re-parsed (the 2nd OOM site). The defs
 * blob is global per `specHash`, so the heavy normalize work is done once at
 * add time and shared across every tenant on the same spec. Falls back to the
 * spec re-parse for legacy rows persisted before the defs blob existed (or if
 * the blob is missing/corrupt).
 */
export const resolveOpenApiBackedTools = ({
  integration,
  config,
  storage,
}: {
  readonly integration: { readonly slug: string };
  readonly config: unknown;
  readonly storage: OpenapiStore;
}): Effect.Effect<ResolveToolsResult, StorageFailure> =>
  Effect.gen(function* () {
    const openApiConfig = decodeOpenApiIntegrationConfig(config);
    if (!openApiConfig) return { tools: [], definitions: {} };
    if (openApiConfig.specHash != null) {
      const defsJson = yield* storage.getDefs(openApiConfig.specHash);
      if (defsJson != null) {
        const definitions = Option.getOrNull(decodeDefsJson(defsJson));
        if (definitions != null) {
          const ops = yield* storage.listOperations(String(integration.slug));
          return { tools: ops.map(toolDefFromStoredOperation), definitions };
        }
      }
    }
    const specText = yield* loadOpenApiSpecText(storage, openApiConfig);
    if (specText == null) return { tools: [], definitions: {} };
    const compiled = yield* compileOpenApiSpec(specText).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!compiled) return { tools: [], definitions: {} };
    return {
      tools: openApiToolDefsFromCompiled(compiled),
      definitions: compiled.hoistedDefs,
    };
  });

export const invokeOpenApiBackedTool = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly toolRow: { readonly integration: string; readonly name: string };
  readonly credential: ToolInvocationCredential;
  readonly args: unknown;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>;
}) =>
  Effect.gen(function* () {
    const integration = input.toolRow.integration;
    const config = decodeOpenApiIntegrationConfig(input.credential.config);

    let binding = (yield* input.ctx.storage.getOperation(integration, input.toolRow.name))?.binding;
    // Only re-parse when the binding is entirely absent (a legacy row predating
    // persisted bindings). A present binding is authoritative even if it has no
    // responseBody: the persisted spec is now the *full* source (37MB for
    // Microsoft Graph), so re-parsing it here to "enrich" a binding would OOM
    // the isolate. A genuinely body-less operation must serve from its binding.
    if (!binding && config) {
      const specText = yield* loadOpenApiSpecText(input.ctx.storage, config).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const compiled =
        specText == null
          ? null
          : yield* compileOpenApiSpec(specText).pipe(Effect.catch(() => Effect.succeed(null)));
      binding = compiled
        ? openApiStoredOperationsFromCompiled(integration, compiled).find(
            (op) => op.toolName === input.toolRow.name,
          )?.binding
        : undefined;
    }
    if (!binding) {
      return yield* new OpenApiExtractionError({
        message: `No OpenAPI operation found for tool "${input.toolRow.name}" on "${integration}"`,
      });
    }

    const headers: Record<string, string> = { ...(config?.headers ?? {}) };
    const queryParams: Record<string, string> = {
      ...(config?.queryParams ?? {}),
    };

    const template = (config?.authenticationTemplate ?? []).find(
      (entry) => String(entry.slug) === String(input.credential.template),
    );
    if (template) {
      const missing = requiredTemplateVariables(template).filter((name) => {
        const value = input.credential.values[name];
        return value == null || value === "";
      });
      if (missing.length > 0) {
        return openApiAuthToolFailure({
          code:
            template.kind === "oauth2" ? "oauth_connection_missing" : "connection_value_missing",
          message: `Connection "${input.credential.connection}" for "${integration}" has no resolvable credential value. Re-authenticate or update the connection.`,
          owner: input.credential.owner,
          integration,
          connection: String(input.credential.connection),
          credentialKind: template.kind === "oauth2" ? "oauth" : "secret",
        });
      }
      const rendered = renderAuthTemplate(template, input.credential.values);
      Object.assign(headers, rendered.headers);
      Object.assign(queryParams, rendered.queryParams);
    }

    const result = yield* invokeWithLayer(
      binding,
      (input.args ?? {}) as Record<string, unknown>,
      config?.baseUrl ?? "",
      headers,
      queryParams,
      input.httpClientLayer,
    );

    const ok = result.status >= 200 && result.status < 300;
    if (!ok) {
      if (result.status === 401 || result.status === 403) {
        return openApiAuthToolFailure({
          code: "connection_rejected",
          status: result.status,
          message: `Upstream rejected credentials for "${integration}" with HTTP ${result.status}. Re-authenticate or update the connection "${input.credential.connection}" before retrying this tool.`,
          owner: input.credential.owner,
          integration,
          connection: String(input.credential.connection),
          credentialKind: "upstream",
          credentialLabel: "Upstream authorization",
          details: result.error,
        });
      }
      return ToolResult.fail({
        code: "upstream_http_error",
        status: result.status,
        message: extractOpenApiUpstreamMessage(result.error, result.status),
        details: result.error,
      });
    }
    return ToolResult.ok(result.data, {
      http: { status: result.status, headers: result.headers },
    });
  });

/** Pre-approval argument validation: run the exact request-building pass
 *  `invoke` runs (path params, request body, base64 payloads) and discard the
 *  built request. Fails with the same pre-flight OpenApiInvocationError the
 *  real invocation would raise, so a call guaranteed to fail is rejected
 *  before the executor pauses it for approval. Legacy rows without a
 *  persisted binding skip validation (re-parsing the spec here would repeat
 *  invokeTool's heavy fallback for no user-visible gain). */
export const validateOpenApiBackedToolArgs = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly toolRow: { readonly integration: string; readonly name: string };
  readonly args: unknown;
}) =>
  Effect.gen(function* () {
    const operation = yield* input.ctx.storage.getOperation(
      input.toolRow.integration,
      input.toolRow.name,
    );
    if (!operation) return;
    yield* buildRequest(operation.binding, (input.args ?? {}) as Record<string, unknown>, {});
  });

export const resolveOpenApiBackedAnnotations = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly integration: string;
  readonly toolRows: readonly { readonly name: string }[];
}) =>
  Effect.gen(function* () {
    const out: Record<string, ReturnType<typeof annotationsForOperation>> = {};
    for (const row of input.toolRows) {
      const operation = yield* input.ctx.storage.getOperation(input.integration, row.name);
      if (!operation) continue;
      out[row.name] = annotationsForOperation(
        operation.binding.method,
        operation.binding.pathTemplate,
      );
    }
    return out;
  });

// ---------------------------------------------------------------------------
// Health checks — the declared liveness/identity probe for a connection.
// ---------------------------------------------------------------------------

/** Resolve the invocation binding for a health-check operation. Unlike the tool
 *  invoke path we do not need `responseBody` (the probe reads the raw response),
 *  so the stored binding is enough; only recompile the spec when it is missing
 *  (e.g. an operation added to the spec but not yet persisted). */
const resolveHealthCheckBinding = (
  ctx: PluginCtx<OpenapiStore>,
  integration: string,
  operation: string,
  config: OpenApiIntegrationConfig | null,
): Effect.Effect<OperationBinding | undefined, StorageFailure> =>
  Effect.gen(function* () {
    const stored = (yield* ctx.storage.getOperation(integration, operation))?.binding;
    if (stored) return stored;
    if (!config) return undefined;
    const specText = yield* loadOpenApiSpecText(ctx.storage, config).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (specText == null) return undefined;
    const compiled = yield* compileOpenApiSpec(specText).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!compiled) return undefined;
    return openApiStoredOperationsFromCompiled(integration, compiled).find(
      (op) => op.toolName === operation,
    )?.binding;
  });

/** Run the given probe against a resolved credential and classify the outcome.
 *  The spec is resolved by CORE (its own storage) and passed in — this never
 *  reads it from the plugin config. Never fails for credential/upstream
 *  reasons: a rejected credential is a `HealthCheckResult` with
 *  `status: "expired"`, not an error. */
export const checkHealthOpenApi = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly integration: IntegrationRecord;
  readonly credential: ToolInvocationCredential;
  readonly spec?: HealthCheckSpec;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>;
}): Effect.Effect<HealthCheckResult, StorageFailure> =>
  Effect.gen(function* () {
    const checkedAt = Date.now();
    const config = decodeOpenApiIntegrationConfig(input.integration.config);
    const spec = input.spec;
    if (!spec) {
      return {
        status: "unknown",
        checkedAt,
        detail: "No health check configured.",
      } satisfies HealthCheckResult;
    }

    const integration = String(input.integration.slug);
    const binding = yield* resolveHealthCheckBinding(
      input.ctx,
      integration,
      spec.operation,
      config,
    );
    if (!binding) {
      return {
        status: "unknown",
        checkedAt,
        detail: `Health check operation "${spec.operation}" not found on "${integration}".`,
      } satisfies HealthCheckResult;
    }

    // HARD block, not just a ranking hint: a health check runs unattended and
    // repeatedly, so a mutating operation must never execute through it — the
    // normal tool path gates these behind approval, and this path has no
    // approval step. The candidate list labels these "(writes)"; refusing here
    // is the enforcement.
    if (REQUIRE_APPROVAL.has(binding.method.toLowerCase())) {
      return {
        status: "unknown",
        checkedAt,
        detail: `Health check operation "${spec.operation}" is a ${binding.method.toUpperCase()} (mutating) — pick a read-only operation.`,
      } satisfies HealthCheckResult;
    }

    const headers: Record<string, string> = { ...(config?.headers ?? {}) };
    const queryParams: Record<string, string> = { ...(config?.queryParams ?? {}) };

    const template = (config?.authenticationTemplate ?? []).find(
      (entry) => String(entry.slug) === String(input.credential.template),
    );
    if (template) {
      const missing = requiredTemplateVariables(template).filter((name) => {
        const value = input.credential.values[name];
        return value == null || value === "";
      });
      if (missing.length > 0) {
        return {
          status: "expired",
          checkedAt,
          detail: `Connection "${input.credential.connection}" has no resolvable credential value.`,
        } satisfies HealthCheckResult;
      }
      const rendered = renderAuthTemplate(template, input.credential.values);
      Object.assign(headers, rendered.headers);
      Object.assign(queryParams, rendered.queryParams);
    }

    // `invokeWithLayer` fails only with the typed `OpenApiInvocationError`
    // (transport / body-read failures before an HTTP status); fold it onto the
    // success channel so a dead upstream reads as `degraded`, not a thrown error.
    const probe = yield* invokeWithLayer(
      binding,
      { ...(spec.args ?? {}) } as Record<string, unknown>,
      config?.baseUrl ?? "",
      headers,
      queryParams,
      input.httpClientLayer,
    ).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catch((failure) => Effect.succeed({ ok: false as const, failure })),
    );

    // Upstream error text can echo the request back (URLs with query params,
    // auth headers) — scrub every credential value out of anything that leaves
    // as `detail` so a probe can never leak the secret it authenticated with.
    const secretValues = Object.values(input.credential.values).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const scrubSecrets = (text: string): string =>
      secretValues.reduce((out, secret) => out.split(secret).join("[redacted]"), text);

    if (!probe.ok) {
      return {
        status: "degraded",
        checkedAt,
        detail: scrubSecrets(`Health check request failed: ${probe.failure.message}`),
      } satisfies HealthCheckResult;
    }

    const status = classifyHttpStatus(probe.result.status);
    const identity =
      status === "healthy" ? extractIdentity(probe.result.data, spec.identityField) : undefined;
    // Sample the returned body ONLY on a healthy probe: the sample exists to
    // pick an identity field, and error bodies (upstream internals, auth error
    // envelopes) have no business in the preview. Non-healthy runs carry the
    // classified `detail` instead.
    const responseSample = status === "healthy" ? extractResponseFields(probe.result.data) : [];
    return {
      status,
      httpStatus: probe.result.status,
      ...(identity !== undefined ? { identity } : {}),
      checkedAt,
      ...(responseSample.length > 0 ? { responseSample } : {}),
      ...(status === "healthy"
        ? {}
        : {
            detail: scrubSecrets(
              extractOpenApiUpstreamMessage(probe.result.error, probe.result.status),
            ),
          }),
    } satisfies HealthCheckResult;
  });

/** List the operations a user can pick as the health check, ranked
 *  non-destructive-first then fewest-required-args so the obvious "GET /me"
 *  identity endpoint floats to the top. Recompiles the spec once (best-effort)
 *  to recover human summaries the stored binding does not keep. */
export const listHealthCheckCandidatesOpenApi = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly integration: IntegrationRecord;
}): Effect.Effect<readonly HealthCheckCandidate[], StorageFailure> =>
  Effect.gen(function* () {
    const integration = String(input.integration.slug);
    const operations = yield* input.ctx.storage.listOperations(integration);
    const config = decodeOpenApiIntegrationConfig(input.integration.config);

    const summaries = new Map<string, string>();
    const responseFieldsByTool = new Map<string, readonly HealthCheckResponseField[]>();
    if (config) {
      const specText = yield* loadOpenApiSpecText(input.ctx.storage, config).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const compiled =
        specText == null
          ? null
          : yield* compileOpenApiSpec(specText).pipe(Effect.catch(() => Effect.succeed(null)));
      if (compiled) {
        for (const def of compiled.definitions) {
          const summary =
            Option.getOrUndefined(def.operation.summary) ??
            Option.getOrUndefined(def.operation.description);
          if (summary) summaries.set(def.toolPath, summary);
          // `outputSchema` is NOT pre-normalized; `hoistedDefs` ARE, so normalize
          // the schema before walking refs against them.
          const fields = projectResponseFields(
            normalizeOpenApiRefs(Option.getOrUndefined(def.operation.outputSchema)),
            compiled.hoistedDefs,
          );
          if (fields.length > 0) responseFieldsByTool.set(def.toolPath, fields);
        }
      }
    }

    const candidates = operations.map((op): HealthCheckCandidate => {
      const method = op.binding.method.toLowerCase();
      const parameters = op.binding.parameters.map((parameter) => ({
        name: parameter.name,
        location: parameter.location,
        required: parameter.required,
        ...(Option.isSome(parameter.description)
          ? { description: parameter.description.value }
          : {}),
      }));
      const responseFields = responseFieldsByTool.get(op.toolName);
      return {
        operation: op.toolName,
        method,
        requiredArgCount: op.binding.parameters.filter((parameter) => parameter.required).length,
        destructive: REQUIRE_APPROVAL.has(method),
        summary: summaries.get(op.toolName) ?? `${method.toUpperCase()} ${op.binding.pathTemplate}`,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(responseFields && responseFields.length > 0 ? { responseFields } : {}),
      };
    });
    return sortHealthCheckCandidatesByIdentity(candidates);
  });
