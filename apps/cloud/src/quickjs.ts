import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
// Static .wasm import: wrangler/workerd compiles this to a WebAssembly.Module at
// BUILD time. Workers forbid runtime WASM compilation (both fetching the .wasm
// and `WebAssembly.instantiate()` of bytes are blocked), so the engine bytes
// MUST be a pre-compiled module imported like this. The file is vendored into
// src/ (copied from @jitl/quickjs-wasmfile-release-sync) because wrangler's
// CompiledWasm module rule is rooted at the app dir and won't match the
// monorepo-root node_modules path — see scripts/vendor-quickjs-wasm.ts.
import wasmModule from "./quickjs-engine.wasm";

import { setQuickJSModule } from "@executor-js/runtime-quickjs";
import { SpanStatusCode, trace } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// QuickJS-on-Workers WASM loading.
//
// The base variant's module loader resolves to the variant package's `workerd`
// build (its `./emscripten-module` export has a `workerd` condition wrangler
// selects) — that build expects the WASM module to be supplied rather than
// fetched/compiled at runtime. `newVariant(base, { wasmModule })` hands it the
// statically-imported, pre-compiled module, and `setQuickJSModule` makes every
// `makeQuickJsExecutor()` reuse it. Preloaded once per isolate.
//
// Callers trigger this lazily, from the artifact smoke-render path only — see
// `session-durable-object.ts`. Instantiation is ~1.4s of CPU, and most
// sessions never render an artifact, so it must not sit on every session
// init. The client span records exactly when/where that cost lands.
// ---------------------------------------------------------------------------

let preloaded: Promise<void> | null = null;

const tracer = trace.getTracer("executor-cloud-quickjs");

export const preloadQuickJs = (): Promise<void> => {
  if (!preloaded) {
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: this module has no Effect context; reset the memoized promise on failure so a retried artifact render can trigger a fresh instantiation instead of caching a permanent rejection
    preloaded = tracer
      .startActiveSpan("quickjs.preload", async (span) => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: promise-native WASM instantiation; recording exception detail on the span before rethrowing
        try {
          const variant = newVariant(baseVariant, { wasmModule });
          const mod = await newQuickJSWASMModuleFromVariant(variant);
          setQuickJSModule(mod);
        } catch (err) {
          // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: normalizing an untyped instantiation failure only for the OTel span record; the original error is rethrown below unchanged
          const cause = err instanceof Error ? err : String(err);
          span.recordException(cause);
          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: same normalization as the recordException line above
          const message = typeof cause === "string" ? cause : cause.message;
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: rethrow after recording so the caller (and the memoization reset below) still observes the failure
          throw err;
        } finally {
          span.end();
        }
      })
      // oxlint-disable-next-line executor/no-promise-catch -- boundary: this module has no Effect context; reset the memoized promise on failure so a retried artifact render can trigger a fresh instantiation instead of caching a permanent rejection
      .catch((err: unknown) => {
        preloaded = null;
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: rethrow so the caller's awaited promise still rejects with the original error
        throw err;
      });
  }
  return preloaded;
};
