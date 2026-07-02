import { definePlugin } from "@executor-js/sdk/core";

import { microsoftPlugin, type MicrosoftPluginOptions } from "../sdk/plugin";
import { MicrosoftGroup } from "./group";
import { MicrosoftHandlers, MicrosoftExtensionService } from "./handlers";

export { MicrosoftGroup } from "./group";
export { MicrosoftHandlers, MicrosoftExtensionService } from "./handlers";

export const microsoftHttpPlugin = definePlugin((options?: MicrosoftPluginOptions) => ({
  ...microsoftPlugin(options),
  routes: () => MicrosoftGroup,
  handlers: () => MicrosoftHandlers,
  extensionService: MicrosoftExtensionService,
}));
