import { definePlugin } from "@executor-js/sdk/core";
import { dynamicUiMcpContribution } from "./mcp";

export {
  DYNAMIC_UI_SHELL_RESOURCE_URI,
  buildRenderUiDescription,
  dynamicUiMcpContribution,
  stripGenerativeUiSection,
  validateRenderUiCode,
} from "./mcp";

/**
 * Dynamic UI is the product-level plugin. Its first contribution is the
 * MCP `render-ui` surface; HTTP routes for saved views, component libraries,
 * and fallback render sessions can live beside it on this plugin later.
 */
export const dynamicUiPlugin = definePlugin(() => ({
  id: "dynamic-ui" as const,
  storage: () => ({}),
  mcp: () => dynamicUiMcpContribution(),
}));
