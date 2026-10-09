/**
 * Public build metadata compiled in by `vite.ts`. `VITE_EXECUTOR_BUILD` exists in the server
 * bundle only; browser code reads the build through `documentBuild`.
 */
declare global {
  interface ImportMetaEnv {
    readonly VITE_EXECUTOR_BUILD: string;
    readonly VITE_EXECUTOR_ENVIRONMENT_NAME: string;
  }
}

export {};
