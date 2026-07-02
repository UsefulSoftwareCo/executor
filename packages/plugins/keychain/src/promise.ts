import { type Plugin } from "@executor-js/sdk";

import {
  keychainPlugin as keychainPluginEffect,
  type KeychainExtension,
  type KeychainPluginConfig,
} from "./index";

export type { KeychainPluginConfig } from "./index";

// Explicit return type so the emitted dist/promise.d.ts references
// `import("@executor-js/sdk").Plugin` rather than the Promise-surface
// root specifier (which doesn't re-export Plugin).
export const keychainPlugin = (
  config?: KeychainPluginConfig,
): Plugin<"keychain", KeychainExtension, Record<string, never>> => keychainPluginEffect(config);
