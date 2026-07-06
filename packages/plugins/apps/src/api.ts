// Host-facing plugin surface for @executor-js/plugin-apps.
export {
  appsPlugin,
  APPS_INTEGRATION_SLUG,
  APPS_PLUGIN_ID,
  APPS_CONNECTION_PREFIX,
  connectionNameForScope,
  scopeFromConnection,
  type AppsPluginOptions,
} from "./plugin/apps-plugin";
export {
  makeSelfHostAppsRuntime,
  type SelfHostAppsRuntime,
  type SelfHostAppsRuntimeOptions,
} from "./plugin/self-host-runtime";
export { makeSqliteAppsStore } from "./backing/sqlite-apps-store";
export {
  BindingError,
  type ClientResolver,
  type ConnectionCandidate,
  type RoleBindings,
} from "./plugin/bindings";
