import { definePlugin } from "@executor-js/sdk/core";

import { makeAppsPlugin, type AppsPluginOptions } from "./plugin/apps-plugin";
import { AppsExtensionService, appsHandlersForSourceKinds } from "./plugin/handlers";
import { appsGroupForSourceKinds } from "./plugin/routes";

export { AppsGroup } from "./plugin/routes";
export { AppsHandlers, AppsExtensionService } from "./plugin/handlers";
export type { PublishInput, PublishResult } from "./pipeline/publish";
export { publish } from "./pipeline/publish";
export { makeAppsPlugin, appsPlugin } from "./plugin/apps-plugin";

export const appsHttpPlugin = definePlugin((options?: AppsPluginOptions) => ({
  ...makeAppsPlugin(options),
  routes: () => appsGroupForSourceKinds(options?.sourceKinds),
  handlers: () => appsHandlersForSourceKinds(options?.sourceKinds),
  extensionService: AppsExtensionService,
}));
