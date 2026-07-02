import { type Plugin } from "@executor-js/sdk";

import {
  fileSecretsPlugin as fileSecretsPluginEffect,
  type FileSecretsExtension,
  type FileSecretsPluginConfig,
} from "./index";

export type { FileSecretsPluginConfig } from "./index";

// Explicit return type so the emitted dist/promise.d.ts references
// `import("@executor-js/sdk").Plugin` rather than the Promise-surface
// root specifier (which doesn't re-export Plugin).
export const fileSecretsPlugin = (
  config?: FileSecretsPluginConfig,
): Plugin<"fileSecrets", FileSecretsExtension, Record<string, never>> =>
  fileSecretsPluginEffect(config);
