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

/**
 * Every response names the server's build in this header, and again as a `Server-Timing` metric of
 * the same name, the only part of its own document response a page can read. A page compares the
 * build its document named with the build each API response names, so a tab left open across an
 * upgrade learns it is running the previous build.
 */
export const buildHeader = "executor-build";
