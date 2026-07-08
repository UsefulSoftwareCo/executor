/* oxlint-disable executor/no-try-catch-or-throw, executor/no-double-cast, executor/no-promise-reject, executor/no-instanceof-tagged-error -- workerd boundary converts worker envelopes into typed AppExecutorError */
import { Effect } from "effect";

import {
  createWorkerdModuleRunner,
  isWorkerdAvailable,
  WORKERD_VERSION,
  type WorkerdModuleRunnerOptions,
} from "@executor-js/runtime-workerd-subprocess";

import { stableStringify } from "../pipeline/descriptor";
import {
  AppExecutorError,
  type AppToolBridge,
  type AppToolExecutor,
  type CollectedModule,
  type InvokeOutcome,
} from "./app-tool-executor";

export { isWorkerdAvailable, WORKERD_VERSION as WORKERD_APP_EXECUTOR_VERSION };

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

const appDriver = (token: string): string => `
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
const jsonSchemaFor = (schema) => schema === undefined ? undefined : (isRecord(schema) && isRecord(schema["~standard"]) ? {} : schema);
const collectIntegrations = (toolName, sourcePath, declarations, inputJsonSchema) => {
  if (declarations === undefined) return {};
  if (!isRecord(declarations)) throw fail("collect", 'tool "' + toolName + '" integrations must be a record', [issue(sourcePath, "integrations must be a record")]);
  const inputProperties = isRecord(inputJsonSchema) && isRecord(inputJsonSchema.properties) ? inputJsonSchema.properties : {};
  const out = {};
  for (const [field, raw] of Object.entries(declarations)) {
    if (Object.prototype.hasOwnProperty.call(inputProperties, field)) {
      throw fail("collect", 'tool "' + toolName + '" integration key "' + field + '" collides with input field', [issue(sourcePath, "integration key collides with input: " + field)]);
    }
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
    properties[field] = decl.mode === "one"
      ? { type: "string", description: decl.description ?? "Connection for " + decl.slug }
      : { type: "array", items: { type: "string" }, description: decl.description ?? "Connections for " + decl.slug };
    required.push(field);
  }
  return { ...base, type: "object", properties, ...(required.length > 0 ? { required: [...new Set(required)] } : {}) };
};
const collectFromExport = (exported, fileSlug, sourcePath) => {
  if (isDefinedTool(exported)) {
    const inputJsonSchema = jsonSchemaFor(exported.input);
    const integrations = collectIntegrations(fileSlug, sourcePath, exported.integrations, inputJsonSchema);
    return { tools: [{ toolName: fileSlug, description: exported.description, integrations, inputSchema: projectInputSchema(inputJsonSchema, integrations), outputSchema: jsonSchemaFor(exported.output), annotations: exported.annotations }] };
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
    const inputJsonSchema = jsonSchemaFor(value.input);
    const integrations = collectIntegrations(toolName, sourcePath, value.integrations, inputJsonSchema);
    seen.add(toolName);
    tools.push({ toolName, exportKey: key, description: value.description, integrations, inputSchema: projectInputSchema(inputJsonSchema, integrations), outputSchema: jsonSchemaFor(value.output), annotations: value.annotations });
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
  if (isRecord(result) && "issues" in result && Array.isArray(result.issues)) {
    throw fail(field === "input" ? "input_validation" : "output_validation", field + " validation failed", undefined, result.issues);
  }
  return isRecord(result) && "value" in result ? result.value : value;
};
const makeClient = (env, root, prefix = []) => new Proxy(() => undefined, {
  get(_target, prop) {
    if (prop === "then" || typeof prop === "symbol") return undefined;
    return makeClient(env, root, [...prefix, String(prop)]);
  },
  async apply(_target, _thisArg, args) {
    const response = await env.HOST.fetch("http://host/tool", {
      method: "POST",
      headers: { "content-type": "application/json", "x-executor-token": ${JSON.stringify(token)} },
      body: JSON.stringify({ toolPath: root + "." + prefix.join("."), args: args[0] ?? {} }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Internal tool error");
    return data.result;
  },
});
const splitInvokeInput = (env, toolName, input, integrations) => {
  const payload = isRecord(input) ? input : {};
  const dataInput = { ...payload };
  const handles = {};
  for (const [field, decl] of Object.entries(integrations)) {
    const raw = payload[field];
    delete dataInput[field];
    if (decl.mode === "one") {
      if (typeof raw !== "string" || raw.length === 0) throw fail("input_validation", 'tool "' + toolName + '" integration "' + field + '" must be a connection address');
      handles[field] = makeClient(env, field);
    } else {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) throw fail("input_validation", 'tool "' + toolName + '" integration "' + field + '" must be connection addresses');
      handles[field] = raw.map((_address, index) => makeClient(env, field + "#" + index));
    }
  }
  return { input: dataInput, integrations: handles };
};
const serializeFailure = (error, fallbackKind) => {
  if (isRecord(error) && error.__appExecutorFailure === true) {
    return { ok: false, kind: error.kind, message: error.message, diagnostics: error.diagnostics, cause: error.cause };
  }
  return { ok: false, kind: fallbackKind, message: error && error.message ? error.message : String(error) };
};

export default {
  async fetch(request, env) {
    if (request.url.endsWith("/__health")) return Response.json({ ok: true, runnerToken: ${JSON.stringify(token)} });
    if (!request.url.endsWith("/run")) return new Response("Not Found", { status: 404 });
    const input = await request.json();
    try {
      if (input.op === "collect") {
        const first = collectFromExport(await resolveDefault(), input.fileSlug, input.sourcePath);
        const second = collectFromExport(await resolveDefault(), input.fileSlug, input.sourcePath);
        if (stableStringify(first) !== stableStringify(second)) throw fail("nondeterministic", "collect for " + input.sourcePath + " is nondeterministic", [issue(input.sourcePath, "factory output changed between runs")]);
        return Response.json({ ok: true, value: first });
      }
      if (input.op === "invoke") {
        const invoke = async () => {
          const exported = await resolveDefault();
          const tool = selectTool(exported, input.toolName);
          if (!isDefinedTool(tool)) throw fail("invoke", "tool not found in bundle: " + input.toolName);
          const inputJsonSchema = jsonSchemaFor(tool.input);
          const integrations = collectIntegrations(input.toolName, input.toolName, tool.integrations, inputJsonSchema);
          const split = splitInvokeInput(env, input.toolName, input.input, integrations);
          const decoded = await validateStandard(tool.input, split.input, "input");
          const output = await tool.handler(decoded, split.integrations);
          return { output: await validateStandard(tool.output, output, "output") };
        };
        const value = await Promise.race([
          invoke(),
          new Promise((_, reject) => setTimeout(() => reject(fail("timeout", "app tool timed out after " + input.timeoutMs + "ms")), input.timeoutMs)),
        ]);
        return Response.json({ ok: true, value });
      }
      return Response.json({ ok: false, kind: "invoke", message: "unknown operation" });
    } catch (error) {
      return Response.json(serializeFailure(error, input.op === "collect" ? "collect" : "invoke"));
    }
  },
};
`;

const collectWithWorkerd = (
  bundle: string,
  input: { readonly fileSlug: string; readonly sourcePath: string },
): Effect.Effect<CollectedModule, AppExecutorError> =>
  Effect.tryPromise({
    try: async () => {
      const token = crypto.randomUUID();
      const runner = createWorkerdModuleRunner({
        mainModule: "driver.js",
        modules: { "driver.js": appDriver(token), "app.js": bundle },
        hostToken: token,
        restartBackoffMs: 1,
      });
      try {
        const response = await runner.run<WorkerEnvelope<CollectedModule>>({
          op: "collect",
          fileSlug: input.fileSlug,
          sourcePath: input.sourcePath,
        });
        if (!response.body.ok) throw toAppExecutorError(response.body, "collect");
        return response.body.value;
      } finally {
        await runner.dispose();
      }
    },
    catch: (cause) => mapCause(cause, "collect", `collect failed for ${input.sourcePath}`),
  }).pipe(
    Effect.flatMap((collected) =>
      stableStringify(collected)
        ? Effect.succeed(collected)
        : Effect.fail(
            new AppExecutorError({
              kind: "collect",
              message: `collect failed for ${input.sourcePath}`,
            }),
          ),
    ),
  );

const invokeWithWorkerd = (
  bundle: string,
  entry: { readonly toolName: string },
  input: unknown,
  bridge: AppToolBridge,
  limits: { readonly timeoutMs: number },
): Effect.Effect<InvokeOutcome, AppExecutorError> =>
  Effect.tryPromise({
    try: async () => {
      const token = crypto.randomUUID();
      const options = {
        mainModule: "driver.js",
        modules: { "driver.js": appDriver(token), "app.js": bundle },
        hostToken: token,
        toolBridge: bridge,
        restartBackoffMs: 1,
      } satisfies WorkerdModuleRunnerOptions;
      const runner = createWorkerdModuleRunner(options);
      try {
        const response = await runner.run<WorkerEnvelope<InvokeOutcome>>(
          {
            op: "invoke",
            toolName: entry.toolName,
            input,
            timeoutMs: limits.timeoutMs,
          },
          limits.timeoutMs,
        );
        if (!response.body.ok) throw toAppExecutorError(response.body, "invoke");
        return response.body.value;
      } finally {
        await runner.dispose();
      }
    },
    catch: (cause) => mapCause(cause, "invoke", "app tool invocation failed"),
  });

export const makeWorkerdAppToolExecutor = (): AppToolExecutor => ({
  collect: collectWithWorkerd,
  invoke: invokeWithWorkerd,
});
