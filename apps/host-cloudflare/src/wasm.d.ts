// On Cloudflare Workers, a `.wasm` import resolves to a pre-compiled
// `WebAssembly.Module` (wrangler's built-in CompiledWasm module rule).
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
