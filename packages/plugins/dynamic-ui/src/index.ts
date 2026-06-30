import { definePlugin, type AnyPlugin } from "@executor-js/sdk/core";
import { dynamicUiMcpContribution } from "./mcp";

export {
  DYNAMIC_UI_SHELL_RESOURCE_URI,
  buildRenderUiDescription,
  dynamicUiMcpContribution,
  validateRenderUiCode,
} from "./mcp";

export const DYNAMIC_UI_PLUGIN_ID = "dynamic-ui";
export const DYNAMIC_UI_MCP_APPS_FEATURE_FLAG = "generated-ui-mcp-apps";

export const filterDynamicUiMcpPlugins = (
  plugins: readonly AnyPlugin[],
  enabled: boolean,
): readonly AnyPlugin[] =>
  enabled ? plugins : plugins.filter((plugin) => plugin.id !== DYNAMIC_UI_PLUGIN_ID);

/**
 * Dynamic UI is the product-level plugin. Its first contribution is the
 * MCP `render-ui` surface; HTTP routes for saved views, component libraries,
 * and fallback render sessions can live beside it on this plugin later.
 */
export const dynamicUiPlugin = definePlugin(() => ({
  id: DYNAMIC_UI_PLUGIN_ID,
  packageName: "@executor-js/plugin-dynamic-ui",
  storage: () => ({}),
  mcp: () => dynamicUiMcpContribution(),
}));
