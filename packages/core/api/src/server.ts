export { ExecutorService, ExecutionEngineService } from "./services";
export {
  CoreHandlers,
  ToolsHandlers,
  IntegrationsHandlers,
  ConnectionsHandlers,
  ProvidersHandlers,
  OAuthHandlers,
  PoliciesHandlers,
  ExecutionsHandlers,
} from "./handlers";
export {
  composePluginApi,
  composePluginHandlers,
  composePluginHandlerLayer,
  providePluginExtensions,
  type PluginExtensionServices,
} from "./plugin-routes";
export { AccountProvider, type AccountProviderShape, type AccountHeaders } from "./account/service";
export { AccountHandlers } from "./account/handlers";
export { requestScopedMiddleware } from "./server/request-scoped";
export { RouterConfigLive } from "./server/router-config";
export { consoleErrorCapture } from "./server/console-error-capture";
export {
  makeExecutionStack,
  CodeExecutorProvider,
  EngineDecorator,
  EngineDecoratorNoop,
  type CodeExecutor,
  type EngineDecoratorShape,
  type EngineStackIdentity,
} from "./server/execution-stack";
export {
  makeMcpBuildServer,
  makeConsoleMcpErrorReporter,
  type McpExecutionStackLayer,
} from "./server/mcp-build";
// Host-composition seams re-homed out of `@executor-js/sdk` (the plugin-author
// contract) into this host surface. The pure FumaDB assembly (`createExecutorFumaDb`
// + its types) keeps its definition in the SDK for the sqlite test backend and is
// re-exported here so hosts get the assembly AND the `DbProvider` seam from one
// place. `collectTables` keeps its definition in the SDK (it is part of
// `createExecutor`'s mechanics) and is re-exported here for hosts/tooling.
export {
  createExecutorFumaDb,
  dbProviderLayer,
  DbProvider,
  type CreateExecutorFumaDbOptions,
  type ExecutorDbHandle,
  type ExecutorDbProvider,
  type ExecutorFumaDb,
  type ExecutorFumaSchema,
} from "./server/executor-fuma-db";
export {
  makeScopedExecutor,
  HostConfig,
  PluginsProvider,
  RequestWebOrigin,
  RequestOrgSlug,
  type HostConfigShape,
  type PluginsProviderShape,
  type RequestWebOriginShape,
  type RequestOrgSlugShape,
} from "./server/scoped-executor";
export { collectTables } from "@executor-js/sdk";
export {
  IdentityProvider,
  AuthContext,
  Unauthorized,
  NoOrganization,
  Unavailable,
  authContextFromPrincipal,
  type Principal,
  type IdentityProviderShape,
  type IdentityFailure,
} from "./server/identity";
export {
  makeExecutionStackMiddleware,
  textFailureStrategy,
  type FailureRenderingStrategy,
  type MakeExecutionStackMiddlewareOptions,
} from "./server/execution-stack-middleware";
export {
  makeFixedExecutionMiddleware,
  FixedExecutionProvider,
  type FixedExecution,
  type MakeFixedExecutionMiddlewareOptions,
} from "./server/fixed-execution-middleware";
export {
  makeProtectedApiLayer,
  makeAccountApiLayer,
  accountProviderMiddlewareLayer,
  toApiHandler,
  type MakeProtectedApiLayerOptions,
  type MakeAccountApiLayerOptions,
  type ApiHandler,
} from "./server/host-foundation";
export {
  makeOAuthClientIdMetadataRoute,
  oauthClientIdMetadataDocumentFromRequest,
  oauthClientIdMetadataDocumentPath,
  oauthClientIdMetadataDocumentTargetPath,
  oauthClientIdMetadataDocumentUrlFromRequest,
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_BASE_PATH,
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_DEFAULT_TARGET,
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_LOCAL_TARGET,
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH,
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_TARGET_PATH_PREFIX,
} from "./server/oauth-client-metadata";
export { makeNpmDistTagsRoute, NPM_DIST_TAGS_PATH } from "./server/npm-dist-tags";
export * as ExecutorApp from "./server/executor-app";
export type {
  ExecutorAppOptions,
  AppProviders,
  CommonProviders,
  ScopedExecutionProviders,
  FixedExecutionProviders,
  AppExtensions,
  AppConfig,
  EngineProviders,
  McpProviders,
} from "./server/executor-app";
