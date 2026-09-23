/** Build-time assets are statically embedded; no runtime compiler or filesystem loader is needed. */
declare module "executor:skills" {
  const skills: Readonly<Record<string, string>>;
  export default skills;
}
declare module "executor:dashboard" {
  const files: Readonly<Record<string, string>>;
  export default files;
}
declare module "executor:pglite.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "executor:initdb.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "executor:pglite.data" {
  const data: ArrayBuffer;
  export default data;
}
