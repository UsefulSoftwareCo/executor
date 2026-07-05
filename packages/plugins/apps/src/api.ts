// HTTP + plugin surface for @executor-js/plugin-apps.
export {
  appsPlugin,
  APPS_INTEGRATION_SLUG,
  APPS_PLUGIN_ID,
  type AppsPluginOptions,
} from "./plugin/apps-plugin";
export { makeAppsHttpRoutes, type AppsHttpDeps } from "./http/routes";
export { registerAppsMcp, type AppsMcpDeps } from "./mcp/register";
