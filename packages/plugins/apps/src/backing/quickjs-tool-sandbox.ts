import { Effect } from "effect";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import {
  InputValidationError,
  OutputValidationError,
  ToolSandboxError,
  type CollectResult,
  type CollectRequest,
  type HandleBridge,
  type InvokeRequest,
  type InvokeResult,
  type ValidationIssue,
  type ToolSandbox,
} from "../seams/tool-sandbox";
import { stableStringify } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// QuickJS-backed ToolSandbox (self-hosted).
//
// The published bundle is a CJS string. The sandbox body prepends a `require`
// shim providing `executor:app` (defineTool/integration),
// then executes the bundle so `module.exports.default` is the artifact. A
// driver appended after the bundle either collects the descriptor (nothing
// bound) or runs one handler with injected clients.
//
// Injected clients are Proxies that turn `github.issues.listForRepo(args)` into
// `await __invokeTool("__handle__", { root, path, args })` — the ONE bridge the
// QuickJS runtime already provides (`tools`/`__invokeTool`). Our
// `SandboxToolInvoker` decodes that and forwards to the host `HandleBridge`.
// Everything crossing is JSON (the cloud version is RPC), so the interface
// stays honest.
//
// Determinism: `collect` runs the collection body twice and byte-compares the
// descriptor JSON. Effectful top-levels (Math.random, Date.now) diverge and are
// rejected. QuickJS denies `fetch` and enforces a deadline + memory cap.
// ---------------------------------------------------------------------------

const COLLECT_TIMEOUT_MS = 10_000;
const INVOKE_TIMEOUT_MS = 30_000;

// The shim + module system injected before the bundle. Kept as a plain string
// (QuickJS evals a string). `defineTool` records its def so the driver can read
// it back. Clients are built by `__mkHandle`.
const runtimePrelude = `
var __modules = {};
var __defs = { tool: null };
function __recordDefault(mod) { return mod; }
var __handleBridge = function(root, path, args) {
  // Route every injected-client method call through the single tool bridge.
  return tools.__handle__({ root: root, path: path, args: args });
};
function __mkHandle(root, prefix) {
  var target = function(){};
  return new Proxy(target, {
    get: function(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return __mkHandle(root, prefix.concat([String(prop)]));
    },
    apply: function(_t, _this, callArgs) {
      return __handleBridge(root, prefix, callArgs);
    }
  });
}
var __executorApp = {
  integration: function(integration) { return { integration: integration }; },
  defineTool: function(def) { __defs.tool = def; return def; },
};
function __require(id) {
  if (id === 'executor:app') return __executorApp;
  throw new Error('module not available in sandbox: ' + id);
}
`;

// Run the CJS bundle. The bundle's virtual entry sets `globalThis.__artifact`
// (the def object returned by defineTool). `require` is our shim; `defineTool`
// also records into `__defs` as a fallback.
const wrapBundle = (bundle: string): string => `
var module = { exports: {} };
var exports = module.exports;
var require = __require;
(function(module, exports, require){
${bundle}
})(module, exports, require);
`;

const parseMarker = (message: string): unknown => {
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const direct = parse(message);
  if (direct) return direct;
  const firstBrace = message.indexOf("{");
  const lastBrace = message.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return parse(message.slice(firstBrace, lastBrace + 1));
  }
  return null;
};

const isMarker = (value: unknown, tag: string): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  return (value as { readonly _tag?: unknown })._tag === tag;
};

const markerMessage = (marker: Record<string, unknown>, fallback: string): string =>
  typeof marker.message === "string" ? marker.message : fallback;

const markerIssues = (marker: Record<string, unknown>): readonly ValidationIssue[] =>
  Array.isArray(marker.issues) ? (marker.issues as readonly ValidationIssue[]) : [];

// Collect driver: describe the artifact's integrations + input/output schema.
// Deterministic JSON only — no handler execution.
const collectDriver = (artifact: string): string => `
return await (async () => {
  var artifactName = ${JSON.stringify(artifact)};
  var fail = function(tag, data) {
    var payload = data || {};
    payload._tag = tag;
    throw JSON.stringify(payload);
  };
  var sanitizeJson = function(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sanitizeJson);
    var out = {};
    for (var key in value) {
      if (key === '~standard') continue;
      if (typeof value[key] === 'function' || value[key] === undefined) continue;
      out[key] = sanitizeJson(value[key]);
    }
    return out;
  };
  var schemaToJson = function(field, schema, direction) {
    if (schema === undefined) return undefined;
    if (schema && typeof schema === 'object' && schema['~standard']) {
      var standard = schema['~standard'];
      var vendor = standard && standard.vendor ? String(standard.vendor) : 'unknown';
      var jsonSchema = standard && standard.jsonSchema;
      if (!jsonSchema || typeof jsonSchema[direction] !== 'function') {
        fail('SchemaExportError', {
          tool: artifactName,
          field: field,
          vendor: vendor,
          message: 'tool "' + artifactName + '" ' + field + ' schema from "' + vendor + '" is not supported for schema export',
        });
      }
      return sanitizeJson(jsonSchema[direction]({ target: 'draft-07' }));
    }
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      return sanitizeJson(schema);
    }
    fail('SchemaExportError', {
      tool: artifactName,
      field: field,
      vendor: 'raw',
      message: 'tool "' + artifactName + '" ' + field + ' schema must be a Standard Schema or raw JSON Schema object',
    });
  };
  var def = __defs.tool || (globalThis.__artifact && (globalThis.__artifact.default || globalThis.__artifact));
  var integrations = {};
  if (def && def.integrations) {
    for (var k in def.integrations) {
      var c = def.integrations[k];
      integrations[k] = { integration: c && c.integration ? String(c.integration) : '' };
    }
  }
  return {
    artifact: artifactName,
    kind: 'tool',
    description: def && def.description,
    integrations: integrations,
    annotations: def && def.annotations,
    hasHandler: !!(def && def.handler),
    inputJsonSchema: def ? schemaToJson('input', def.input, 'input') : undefined,
    outputJsonSchema: def && def.output !== undefined ? schemaToJson('output', def.output, 'output') : undefined,
  };
})()
`;

const buildCollectCode = (bundle: string, request?: CollectRequest): string =>
  runtimePrelude + wrapBundle(bundle) + collectDriver(request?.artifact ?? "default");

// Invoke driver: build injected clients from the request roots, validate
// Standard Schema input/output inside the sandbox, then call the artifact's
// handler with (input, injected).
const buildInvokeDriver = (request: InvokeRequest): string => {
  const rootsLiteral = JSON.stringify(request.roots);
  const inputLiteral = JSON.stringify(request.input ?? {});
  return `
return await (async () => {
  var def = __defs.tool || (globalThis.__artifact && (globalThis.__artifact.default || globalThis.__artifact));
  if (!def || typeof def.handler !== 'function') throw new Error('artifact has no handler: ${request.artifact}');
  var failValidation = function(tag, field, issues) {
    throw JSON.stringify({
      _tag: tag,
      tool: '${request.artifact}',
      field: field,
      message: 'tool "${request.artifact}" ' + field + ' validation failed',
      issues: JSON.parse(JSON.stringify(issues || [])),
    });
  };
  var validateWithStandardSchema = async function(field, schema, value) {
    if (!schema || typeof schema !== 'object' || !schema['~standard']) return value;
    var standard = schema['~standard'];
    if (!standard || typeof standard.validate !== 'function') return value;
    var result = await standard.validate(value);
    if (result && result.issues) {
      failValidation(field === 'input' ? 'InputValidationError' : 'OutputValidationError', field, result.issues);
    }
    return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : value;
  };
  var roots = ${rootsLiteral};
  var injected = {};
  for (var name in roots) {
    var spec = roots[name];
    if (spec.kind !== 'single') throw new Error('unsupported handle root kind: ' + spec.kind);
    injected[name] = __mkHandle(name, []);
  }
  var input = await validateWithStandardSchema('input', def.input, ${inputLiteral});
  var out = await def.handler(input, injected);
  out = await validateWithStandardSchema('output', def.output, out);
  return out;
})()
`;
};

const buildInvokeCode = (bundle: string, request: InvokeRequest): string =>
  runtimePrelude + wrapBundle(bundle) + buildInvokeDriver(request);

// A no-op invoker for collect: no handle calls should happen; if they do
// (misbehaving describe path), fail loudly.
const collectInvoker: SandboxToolInvoker = {
  invoke: () => Effect.fail(new Error("collect must not make handle calls")) as never,
};

export interface QuickjsToolSandboxOptions {
  readonly collectTimeoutMs?: number;
  readonly invokeTimeoutMs?: number;
}

export const makeQuickjsToolSandbox = (options: QuickjsToolSandboxOptions = {}): ToolSandbox => {
  const collectExecutor = makeQuickJsExecutor({
    timeoutMs: options.collectTimeoutMs ?? COLLECT_TIMEOUT_MS,
  });
  const invokeExecutor = makeQuickJsExecutor({
    timeoutMs: options.invokeTimeoutMs ?? INVOKE_TIMEOUT_MS,
  });

  const runCollect = (code: string): Effect.Effect<unknown, ToolSandboxError> =>
    collectExecutor.execute(code, collectInvoker).pipe(
      Effect.mapError(
        (cause) => new ToolSandboxError({ kind: "collect", message: "collect run failed", cause }),
      ),
      Effect.flatMap((result) => {
        if (result.error) {
          const marker = parseMarker(result.error);
          if (isMarker(marker, "SchemaExportError")) {
            return Effect.fail(
              new ToolSandboxError({
                kind: "collect",
                message: markerMessage(marker, result.error),
                cause: marker,
              }),
            );
          }
          return Effect.fail(new ToolSandboxError({ kind: "collect", message: result.error }));
        }
        return Effect.succeed(result.result);
      }),
    );

  return {
    collect: (bundle: string, request?: CollectRequest) =>
      Effect.gen(function* () {
        // Run twice, byte-compare (determinism gate). Key-sorted stringify so a
        // false mismatch never comes from property-order luck — a real
        // divergence (Math.random / Date.now) still fails.
        const first = yield* runCollect(buildCollectCode(bundle, request));
        const second = yield* runCollect(buildCollectCode(bundle, request));
        const a = stableStringify(first);
        const b = stableStringify(second);
        if (a !== b) {
          return yield* Effect.fail(
            new ToolSandboxError({
              kind: "nondeterministic",
              message:
                "descriptor collection is non-deterministic (an artifact read Math.random/Date.now or otherwise diverged between runs)",
            }),
          );
        }
        const descriptor = first as { artifact?: string };
        const result: CollectResult = {
          artifacts: {
            [String(descriptor.artifact ?? "default")]: {
              kind: "tool",
              descriptor: first,
            },
          },
        };
        return result;
      }),

    invoke: (bundle: string, request: InvokeRequest, bridge: HandleBridge) =>
      Effect.gen(function* () {
        // The invoker decodes the routed handle call and forwards to the host
        // bridge. Path 0 is `__handle__`; the single arg is {root, path, args}.
        const invoker: SandboxToolInvoker = {
          invoke: (input: { path: string; args: unknown }) => {
            // Strictness (grafted from A): the ONLY reserved bridge path the
            // invoke phase accepts is `__handle__`. Anything else is a hard
            // error, never silently ignored — a handler must not reach the host
            // through an unexpected channel.
            if (input.path !== "__handle__") {
              return Effect.fail(
                new Error(`unexpected sandbox bridge path: ${input.path}`),
              ) as never;
            }
            const call = input.args as {
              root: string;
              path: readonly string[];
              args: readonly unknown[];
            };
            if (!call || typeof call.root !== "string" || !Array.isArray(call.path)) {
              return Effect.fail(new Error("malformed sandbox bridge call")) as never;
            }
            return bridge.call({ root: call.root, path: call.path, args: call.args }) as never;
          },
        };
        const result = yield* invokeExecutor
          .execute(buildInvokeCode(bundle, request), invoker)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolSandboxError({ kind: "invoke", message: "invoke run failed", cause }),
            ),
          );
        if (result.error) {
          const marker = parseMarker(result.error);
          if (isMarker(marker, "InputValidationError")) {
            return yield* Effect.fail(
              new InputValidationError({
                message: markerMessage(marker, "input validation failed"),
                issues: markerIssues(marker),
              }),
            );
          }
          if (isMarker(marker, "OutputValidationError")) {
            return yield* Effect.fail(
              new OutputValidationError({
                message: markerMessage(marker, "output validation failed"),
                issues: markerIssues(marker),
              }),
            );
          }
          return yield* Effect.fail(
            new ToolSandboxError({ kind: "invoke", message: result.error }),
          );
        }
        return { output: result.result, logs: result.logs ?? [] } satisfies InvokeResult;
      }),
  };
};
