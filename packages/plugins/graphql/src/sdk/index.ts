export { introspect, parseIntrospectionJson } from "./introspect";
export { extract, type ExtractionOutput } from "./extract";
export { invoke, invokeWithLayer } from "./invoke";
export {
  describeGraphqlAuthMethods,
  graphqlPlugin,
  type GraphqlPluginExtension,
  type GraphqlPluginOptions,
  type GraphqlAddIntegrationInput,
  type GraphqlConfigureInput,
  type GraphqlConfigureAuthInput,
} from "./plugin";
export { makeDefaultGraphqlStore, type GraphqlStore, type StoredOperation } from "./store";

export {
  GraphqlIntrospectionError,
  GraphqlExtractionError,
  GraphqlInvocationError,
  GraphqlAuthRequiredError,
} from "./errors";

export {
  decodeGraphqlIntegrationConfig,
  decodeGraphqlIntegrationConfigOption,
  ExtractedField,
  ExtractionResult,
  GraphqlArgument,
  GraphqlAuthMethod,
  GraphqlAuthMethodInput,
  GraphqlIntegrationConfig,
  GraphqlOAuthMethod,
  GraphqlOperationKind,
  InvocationResult,
  normalizeGraphqlAuthMethods,
  OperationBinding,
} from "./types";

export { migrateGraphqlAuthConfig } from "./migrate-config";

// Request-shaped authoring: `headers: { Authorization: ["Bearer ", variable("token")] }`.
export { variable, type ApiKeyAuthTemplate } from "@executor-js/sdk/http-auth";
