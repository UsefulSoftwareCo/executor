import { definePlugin } from "@executor-js/sdk/core";

import { googlePlugin, type GooglePluginOptions } from "../sdk/plugin";
import { GoogleGroup } from "./group";
import { GoogleHandlers, GoogleExtensionService } from "./handlers";

export { GoogleGroup } from "./group";
export { GoogleHandlers, GoogleExtensionService } from "./handlers";

export const googleHttpPlugin = definePlugin((options?: GooglePluginOptions) => ({
  ...googlePlugin(options),
  routes: () => GoogleGroup,
  handlers: () => GoogleHandlers,
  extensionService: GoogleExtensionService,
}));
