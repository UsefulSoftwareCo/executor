declare module "virtual:executor/worker-bundler-artifact" {
  export const sourcePath: string;
  export const wasmPath: string;
  export const source: string | undefined;
  export const wasmBase64: string | undefined;
}
