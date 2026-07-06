import { Effect } from "effect";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import {
  ToolSandboxError,
  type CollectResult,
  type HandleBridge,
  type InvokeRequest,
  type InvokeResult,
  type ToolSandbox,
} from "../seams/tool-sandbox";
import { stableStringify } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// QuickJS-backed ToolSandbox (self-hosted).
//
// The published bundle is a CJS string. The sandbox body prepends a `require`
// shim providing `executor:app` (defineTool/connection/connections/catalog),
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
  connection: function(integration, opts) { return { __decl: 'single', integration: integration, description: opts && opts.description }; },
  connections: function(integration, opts) { return { __decl: 'array', integration: integration, description: opts && opts.description }; },
  catalog: function() { return { __decl: 'catalog' }; },
  defineTool: function(def) { __defs.tool = def; return def; },
};
function __require(id) {
  if (id === 'executor:app') return __executorApp;
  throw new Error('module not available in sandbox: ' + id);
}
`;

// Run the CJS bundle. The bundle's virtual entry sets `globalThis.__artifact`
// (the def object returned by defineTool), `globalThis.__zodToJson` and
// `__zodToJsonOutput` (bound to the author's inlined zod). `require` is our
// shim; `defineTool` also records into `__defs` as a fallback.
const wrapBundle = (bundle: string): string => `
var module = { exports: {} };
var exports = module.exports;
var require = __require;
(function(module, exports, require){
${bundle}
})(module, exports, require);
`;

// Collect driver: describe the artifact's connections + input/output schema.
// Deterministic JSON only — no handler execution.
const collectDriver = `
return await (async () => {
  var def = __defs.tool || (globalThis.__artifact && (globalThis.__artifact.default || globalThis.__artifact));
  var conns = {};
  if (def && def.connections) {
    for (var k in def.connections) {
      var c = def.connections[k];
      conns[k] = { decl: c && c.__decl ? c.__decl : 'single', integration: c && c.integration, description: c && c.description };
    }
  }
  var toJson = (typeof globalThis.__zodToJson === 'function') ? globalThis.__zodToJson : function(){ return undefined; };
  var toJsonOut = (typeof globalThis.__zodToJsonOutput === 'function') ? globalThis.__zodToJsonOutput : function(){ return undefined; };
  return {
    kind: 'tool',
    description: def && def.description,
    connections: conns,
    annotations: def && def.annotations,
    hasHandler: !!(def && def.handler),
    inputJsonSchema: def ? toJson(def.input) : undefined,
    outputJsonSchema: def ? toJsonOut(def.output) : undefined,
  };
})()
`;

const buildCollectCode = (bundle: string): string =>
  runtimePrelude + wrapBundle(bundle) + collectDriver;

// Invoke driver: build injected clients from the request roots, then call the
// artifact's handler with (input, injected). Fan-out arrays become arrays of
// element handles.
const buildInvokeDriver = (request: InvokeRequest): string => {
  const rootsLiteral = JSON.stringify(request.roots);
  const inputLiteral = JSON.stringify(request.input ?? {});
  return `
return await (async () => {
  var def = __defs.tool || (globalThis.__artifact && (globalThis.__artifact.default || globalThis.__artifact));
  if (!def || typeof def.handler !== 'function') throw new Error('artifact has no handler: ${request.artifact}');
  var roots = ${rootsLiteral};
  var injected = {};
  for (var name in roots) {
    var spec = roots[name];
    if (spec.kind === 'array') {
      var arr = [];
      for (var i = 0; i < spec.count; i++) arr.push(__mkHandle(name + '#' + i, []));
      injected[name] = arr;
    } else {
      injected[name] = __mkHandle(name, []);
    }
  }
  var out = await def.handler(${inputLiteral}, injected);
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

  const runCollect = (bundle: string): Effect.Effect<unknown, ToolSandboxError> =>
    collectExecutor.execute(buildCollectCode(bundle), collectInvoker).pipe(
      Effect.mapError(
        (cause) => new ToolSandboxError({ kind: "collect", message: "collect run failed", cause }),
      ),
      Effect.flatMap((result) => {
        if (result.error) {
          return Effect.fail(new ToolSandboxError({ kind: "collect", message: result.error }));
        }
        return Effect.succeed(result.result);
      }),
    );

  return {
    collect: (bundle: string) =>
      Effect.gen(function* () {
        // Run twice, byte-compare (determinism gate). Key-sorted stringify so a
        // false mismatch never comes from property-order luck — a real
        // divergence (Math.random / Date.now) still fails.
        const first = yield* runCollect(bundle);
        const second = yield* runCollect(bundle);
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
          return yield* Effect.fail(
            new ToolSandboxError({ kind: "invoke", message: result.error }),
          );
        }
        return { output: result.result, logs: result.logs ?? [] } satisfies InvokeResult;
      }),
  };
};
