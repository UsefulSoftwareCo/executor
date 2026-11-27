declare global {
  interface ImportMetaEnv {
    readonly VITE_EXECUTOR_BUILD: string;
    readonly VITE_EXECUTOR_ENVIRONMENT_NAME: string;
  }
}

export const buildHeader = "executor-build";
