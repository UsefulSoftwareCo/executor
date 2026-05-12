/// <reference types="vite/client" />

declare module "virtual:executor/plugins-client" {
  import type { ClientPluginSpec } from "@executor-js/sdk/client";
  export const plugins: readonly ClientPluginSpec[];
}
