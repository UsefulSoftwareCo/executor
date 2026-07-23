/* oxlint-disable executor/no-try-catch-or-throw, executor/no-double-cast, executor/no-instanceof-tagged-error, executor/no-error-constructor -- boundary: Worker Loader RPC adapter converts worker envelopes into typed AppExecutorError */
import { Effect } from "effect";

import { stableStringify } from "../pipeline/descriptor";
import {
  AppExecutorError,
  type AppToolBridge,
  type AppToolExecutor,
  type CollectedModule,
  type InvokeOutcome,
} from "./app-tool-executor";

type DynamicWorkerDefinition = {
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: string[];
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly globalOutbound?: null;
};

type DynamicWorkerLoader = {
  readonly load?: (code: DynamicWorkerDefinition) => { readonly getEntrypoint: () => unknown };
  readonly get?: (
    name: string | null,
    factory: () => DynamicWorkerDefinition,
  ) => { readonly getEntrypoint: () => unknown };
};

type DynamicAppEntrypoint = {
  readonly collect: (input: {
    readonly fileSlug: string;
    readonly sourcePath: string;
  }) => Promise<WorkerEnvelope<CollectedModule>>;
  readonly invoke: (
    input: {
      readonly toolName: string;
      readonly input: unknown;
      readonly timeoutMs: number;
    },
    bridge: AppToolBridge,
  ) => Promise<WorkerEnvelope<InvokeOutcome>>;
};

type WorkerSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

type WorkerFailure = {
  readonly ok: false;
  readonly kind: AppExecutorError["kind"];
  readonly message: string;
  readonly diagnostics?: readonly { readonly path: string; readonly message: string }[];
  readonly cause?: unknown;
};

type WorkerEnvelope<T> = WorkerSuccess<T> | WorkerFailure;

export interface DynamicWorkerAppToolExecutorOptions {
  readonly loader: DynamicWorkerLoader;
}

const toAppExecutorError = (failure: WorkerFailure, fallbackKind: AppExecutorError["kind"]) =>
  new AppExecutorError({
    kind: failure.kind ?? fallbackKind,
    message: failure.message,
    ...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
  });

const mapCause = (cause: unknown, kind: AppExecutorError["kind"], message: string) =>
  cause instanceof AppExecutorError
    ? cause
    : new AppExecutorError({
        kind,
        message,
        cause,
      });

// Bump this when appWorkerModule() changes so stable Worker Loader IDs do not
// reuse an isolate running an older driver around byte-identical app bundles.
export const DRIVER_VERSION = "2";

const appWorkerModule = (): string => `
import { WorkerEntrypoint } from "cloudflare:workers";
import artifact from "./app.js";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validToolKey = (value) => /^[a-z][a-z0-9-]*(?:_[a-z0-9-]+)*$/.test(value);
const stableStringify = (value) => {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const key of Object.keys(v).sort()) {
      const inner = v[key];
      if (inner !== undefined) out[key] = walk(inner);
    }
    return out;
  };
  return JSON.stringify(walk(value));
};
const issue = (path, message) => ({ path, message });
const fail = (kind, message, diagnostics, cause) => ({ __appExecutorFailure: true, kind, message, diagnostics, cause });
const isDefinedTool = (value) =>
  isRecord(value) &&
  value["~executorAppTool"] === true &&
  typeof value.description === "string" &&
  "input" in value &&
  typeof value.handler === "function";
const resolveDefault = async () => typeof artifact === "function" ? await artifact() : artifact;
const integrationDeclaration = (value) => {
  if (!isRecord(value) || value.kind !== "integration") return null;
  if (typeof value.slug !== "string" || (value.mode !== "one" && value.mode !== "many")) return null;
  return { slug: value.slug, mode: value.mode, ...(typeof value.description === "string" ? { description: value.description } : {}) };
};
const jsonSchemaFor = (schema, side, toolName, sourcePath) => {
  if (schema === undefined) return undefined;
  if (!isRecord(schema) || !isRecord(schema["~standard"])) return schema;
  const jsonSchema = schema["~standard"].jsonSchema;
  if (!isRecord(jsonSchema) || typeof jsonSchema[side] !== "function") {
    throw fail("collect", 'tool "' + toolName + '" ' + side + ' schema library does not expose the Standard Schema jsonSchema extension', [issue(sourcePath, side + " schema library does not expose the Standard Schema jsonSchema extension")]);
  }
  try {
    const converted = jsonSchema[side]({ target: "draft-2020-12" });
    if (!isRecord(converted)) return converted;
    const { $schema: _metaSchema, ...withoutMetaSchema } = converted;
    return withoutMetaSchema;
  } catch (cause) {
    throw fail("collect", 'tool "' + toolName + '" ' + side + ' schema conversion failed', [issue(sourcePath, side + " schema conversion failed")], cause);
  }
};
const collectIntegrations = (toolName, sourcePath, declarations, inputJsonSchema) => {
  if (declarations === undefined) return {};
  if (!isRecord(declarations)) throw fail("collect", 'tool "' + toolName + '" integrations must be a record', [issue(sourcePath, "integrations must be a record")]);
  const inputProperties = isRecord(inputJsonSchema) && isRecord(inputJsonSchema.properties) ? inputJsonSchema.properties : {};
  const out = {};
  for (const [field, raw] of Object.entries(declarations)) {
    if (Object.prototype.hasOwnProperty.call(inputProperties, field)) throw fail("collect", 'tool "' + toolName + '" integration key "' + field + '" collides with input field', [issue(sourcePath, "integration key collides with input: " + field)]);
    const decl = integrationDeclaration(raw);
    if (!decl) throw fail("collect", 'tool "' + toolName + '" integration "' + field + '" is not a valid declaration', [issue(sourcePath, "invalid integration declaration: " + field)]);
    out[field] = decl;
  }
  return out;
};
const projectInputSchema = (inputJsonSchema, integrations) => {
  const base = isRecord(inputJsonSchema) ? inputJsonSchema : {};
  const properties = isRecord(base.properties) ? { ...base.properties } : {};
  const required = Array.isArray(base.required) ? [...base.required] : [];
  for (const [field, decl] of Object.entries(integrations)) {
    properties[field] = decl.mode === "one" ? { type: "string", description: decl.description ?? "Connection for " + decl.slug } : { type: "array", items: { type: "string" }, description: decl.description ?? "Connections for " + decl.slug };
    required.push(field);
  }
  return { ...base, type: "object", properties, ...(required.length > 0 ? { required: [...new Set(required)] } : {}) };
};
const collectFromExport = (exported, fileSlug, sourcePath) => {
  if (isDefinedTool(exported)) {
    const inputJsonSchema = jsonSchemaFor(exported.input, "input", fileSlug, sourcePath);
    const integrations = collectIntegrations(fileSlug, sourcePath, exported.integrations, inputJsonSchema);
    return { tools: [{ toolName: fileSlug, description: exported.description, integrations, inputSchema: projectInputSchema(inputJsonSchema, integrations), outputSchema: jsonSchemaFor(exported.output, "output", fileSlug, sourcePath), annotations: exported.annotations }] };
  }
  if (!isRecord(exported)) throw fail("collect", "default export in " + sourcePath + " must be a tool, record, or factory", [issue(sourcePath, "unsupported default export")]);
  const tools = [];
  const seen = new Set();
  if (isDefinedTool(exported[fileSlug])) throw fail("collect", 'record export key "' + fileSlug + '" collides with single tool name', [issue(sourcePath, 'record key "' + fileSlug + '" is reserved')]);
  for (const [key, value] of Object.entries(exported)) {
    if (!isDefinedTool(value)) continue;
    if (!validToolKey(key)) throw fail("collect", 'record export key "' + key + '" is not a valid tool slug', [issue(sourcePath, "invalid record key " + key)]);
    const toolName = fileSlug + "__" + key;
    if (seen.has(toolName)) throw fail("collect", 'duplicate tool name "' + toolName + '"', [issue(sourcePath, "duplicate tool name " + toolName)]);
    const inputJsonSchema = jsonSchemaFor(value.input, "input", toolName, sourcePath);
    const integrations = collectIntegrations(toolName, sourcePath, value.integrations, inputJsonSchema);
    seen.add(toolName);
    tools.push({ toolName, exportKey: key, description: value.description, integrations, inputSchema: projectInputSchema(inputJsonSchema, integrations), outputSchema: jsonSchemaFor(value.output, "output", toolName, sourcePath), annotations: value.annotations });
  }
  if (tools.length === 0) throw fail("collect", "record export in " + sourcePath + " contains no defineTool entries", [issue(sourcePath, "no tools found")]);
  return { tools };
};
const selectTool = (exported, entry) => {
  if (isDefinedTool(exported)) return exported;
  if (!isRecord(exported)) return null;
  const index = entry.indexOf("__");
  return index === -1 ? null : exported[entry.slice(index + 2)];
};
const validateStandard = async (schema, value, field) => {
  if (!isRecord(schema) || !isRecord(schema["~standard"]) || typeof schema["~standard"].validate !== "function") return value;
  const result = await schema["~standard"].validate(value);
  if (isRecord(result) && "issues" in result && Array.isArray(result.issues)) throw fail(field === "input" ? "input_validation" : "output_validation", field + " validation failed", undefined, result.issues);
  return isRecord(result) && "value" in result ? result.value : value;
};
const makeClient = (bridge, root, prefix = []) => new Proxy(() => undefined, {
  get(_target, prop) {
    if (prop === "then" || typeof prop === "symbol") return undefined;
    return makeClient(bridge, root, [...prefix, String(prop)]);
  },
  async apply(_target, _thisArg, args) {
    return await bridge.call(root + "." + prefix.join("."), args[0] ?? {});
  },
});
const splitInvokeInput = (bridge, toolName, input, integrations) => {
  const payload = isRecord(input) ? input : {};
  const dataInput = { ...payload };
  const handles = {};
  for (const [field, decl] of Object.entries(integrations)) {
    const raw = payload[field];
    delete dataInput[field];
    if (decl.mode === "one") {
      if (typeof raw !== "string" || raw.length === 0) throw fail("input_validation", 'tool "' + toolName + '" integration "' + field + '" must be a connection address');
      handles[field] = makeClient(bridge, field);
    } else {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) throw fail("input_validation", 'tool "' + toolName + '" integration "' + field + '" must be connection addresses');
      handles[field] = raw.map((_address, index) => makeClient(bridge, field + "#" + index));
    }
  }
  return { input: dataInput, integrations: handles };
};
const serializeFailure = (error, fallbackKind) => {
  if (isRecord(error) && error.__appExecutorFailure === true) return { ok: false, kind: error.kind, message: error.message, diagnostics: error.diagnostics, cause: error.cause };
  return { ok: false, kind: fallbackKind, message: error && error.message ? error.message : String(error) };
};

export default class AppExecutor extends WorkerEntrypoint {
  async collect(input) {
    try {
      const first = collectFromExport(await resolveDefault(), input.fileSlug, input.sourcePath);
      const second = collectFromExport(await resolveDefault(), input.fileSlug, input.sourcePath);
      if (stableStringify(first) !== stableStringify(second)) throw fail("nondeterministic", "collect for " + input.sourcePath + " is nondeterministic", [issue(input.sourcePath, "factory output changed between runs")]);
      return { ok: true, value: first };
    } catch (error) {
      return serializeFailure(error, "collect");
    }
  }

  async invoke(input, bridge) {
    try {
      const invoke = async () => {
        const exported = await resolveDefault();
        const tool = selectTool(exported, input.toolName);
        if (!isDefinedTool(tool)) throw fail("invoke", "tool not found in bundle: " + input.toolName);
        const inputJsonSchema = jsonSchemaFor(tool.input, "input", input.toolName, input.toolName);
        const integrations = collectIntegrations(input.toolName, input.toolName, tool.integrations, inputJsonSchema);
        const split = splitInvokeInput(bridge, input.toolName, input.input, integrations);
        const decoded = await validateStandard(tool.input, split.input, "input");
        const output = await tool.handler(decoded, split.integrations);
        return { output: await validateStandard(tool.output, output, "output") };
      };
      let timer;
      try {
        const value = await Promise.race([
          invoke(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail("timeout", "app tool timed out after " + input.timeoutMs + "ms")), input.timeoutMs);
          }),
        ]);
        return { ok: true, value };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      return serializeFailure(error, "invoke");
    }
  }
}
`;

const asEntrypoint = (value: unknown): DynamicAppEntrypoint => value as DynamicAppEntrypoint;

type StartedDynamicAppWorker = {
  readonly stub: { readonly getEntrypoint: () => unknown };
  readonly entrypoint: DynamicAppEntrypoint;
};

const workerDefinition = (bundle: string): DynamicWorkerDefinition => ({
  compatibilityDate: "2025-06-01",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "driver.js",
  modules: {
    "driver.js": appWorkerModule(),
    "app.js": bundle,
  },
  globalOutbound: null,
});

const startOneShotWorker = (
  loader: DynamicWorkerLoader,
  bundle: string,
): StartedDynamicAppWorker => {
  const definition = workerDefinition(bundle);
  const worker =
    loader.load !== undefined
      ? loader.load(definition)
      : loader.get?.(`app-tool-${crypto.randomUUID()}`, () => definition);
  if (worker === undefined) {
    throw new AppExecutorError({
      kind: "collect",
      message: "Worker Loader binding does not support load() or get()",
    });
  }
  return { stub: worker, entrypoint: asEntrypoint(worker.getEntrypoint()) };
};

const startStableWorker = (
  loader: DynamicWorkerLoader,
  bundle: string,
  isolateKey: string,
): StartedDynamicAppWorker => {
  const worker = loader.get?.(isolateKey, () => workerDefinition(bundle));
  if (worker === undefined) {
    throw new AppExecutorError({
      kind: "invoke",
      message: "Worker Loader binding does not support get()",
    });
  }
  return { stub: worker, entrypoint: asEntrypoint(worker.getEntrypoint()) };
};

export const makeDynamicWorkerAppToolExecutor = (
  options: DynamicWorkerAppToolExecutorOptions,
): AppToolExecutor => ({
  collect: (bundle, input) =>
    Effect.tryPromise({
      try: async () => {
        const worker = startOneShotWorker(options.loader, bundle);
        const response = await worker.entrypoint.collect(input);
        if (!response.ok) throw toAppExecutorError(response, "collect");
        if (!stableStringify(response.value))
          throw new Error(`collect failed for ${input.sourcePath}`);
        return response.value;
      },
      catch: (cause) => mapCause(cause, "collect", `collect failed for ${input.sourcePath}`),
    }),
  invoke: (bundle, entry, input, bridge, limits) =>
    Effect.tryPromise({
      try: async () => {
        const worker = startStableWorker(
          options.loader,
          bundle,
          limits.isolateKey ?? `app-tool-${crypto.randomUUID()}`,
        );
        const response = await worker.entrypoint.invoke(
          { toolName: entry.toolName, input, timeoutMs: limits.timeoutMs },
          bridge,
        );
        if (!response.ok) throw toAppExecutorError(response, "invoke");
        return response.value;
      },
      catch: (cause) => mapCause(cause, "invoke", "app tool invocation failed"),
    }),
});
