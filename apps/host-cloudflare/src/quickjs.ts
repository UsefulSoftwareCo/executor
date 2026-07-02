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

// ---------------------------------------------------------------------------
// QuickJS-on-Workers WASM loading.
//
// The base variant's module loader resolves to the variant package's `workerd`
// build (its `./emscripten-module` export has a `workerd` condition wrangler
// selects) — that build expects the WASM module to be supplied rather than
// fetched/compiled at runtime. `newVariant(base, { wasmModule })` hands it the
// statically-imported, pre-compiled module, and `setQuickJSModule` makes every
// `makeQuickJsExecutor()` reuse it. Preloaded once per isolate.
// ---------------------------------------------------------------------------

let preloaded: Promise<void> | null = null;

export const preloadQuickJs = (): Promise<void> => {
  if (!preloaded) {
    const variant = newVariant(baseVariant, { wasmModule });
    preloaded = newQuickJSWASMModuleFromVariant(variant).then((mod) => {
      setQuickJSModule(mod);
    });
  }
  return preloaded;
};
