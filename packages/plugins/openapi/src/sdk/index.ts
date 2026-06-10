export { parse, resolveSpecText, fetchSpecText } from "./parse";
export {
  convertGoogleDiscoveryBundleToOpenApi,
  convertGoogleDiscoveryToOpenApi,
  fetchGoogleDiscoveryDocument,
  isGoogleDiscoveryUrl,
  type GoogleDiscoveryOpenApiConversion,
} from "./google-discovery";
export { extract } from "./extract";
export { invoke, invokeWithLayer, annotationsForOperation } from "./invoke";
export {
  openApiPlugin,
  type OpenApiSpecConfig,
  type OpenApiConfigureInput,
  type OpenApiSpecInput,
  type OpenApiPreviewInput,
  type OpenApiPluginExtension,
  type OpenApiPluginOptions,
} from "./plugin";
export { type OpenapiStore, type StoredOperation, makeDefaultOpenapiStore } from "./store";
export {
  decodeOpenApiIntegrationConfig,
  renderAuthTemplate,
  AuthenticationSchema,
  OpenApiIntegrationConfigSchema,
  type OpenApiIntegrationConfig,
  type RenderedAuth,
} from "./config";
export {
  previewSpec,
  SecurityScheme,
  AuthStrategy,
  HeaderPreset,
  OAuth2Preset,
  OAuth2Flows,
  OAuth2AuthorizationCodeFlow,
  OAuth2ClientCredentialsFlow,
  PreviewOperation,
  SpecPreview,
} from "./preview";
export {
  DocResolver,
  resolveBaseUrl,
  substituteUrlVariables,
  preferredContent,
} from "./openapi-utils";

export {
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiInvocationError,
  OpenApiOAuthError,
  OpenApiAuthRequiredError,
} from "./errors";

export {
  EncodingObject,
  ExtractedOperation,
  ExtractionResult,
  InvocationResult,
  MediaBinding,
  OperationBinding,
  OperationParameter,
  OperationRequestBody,
  ServerInfo,
  ServerVariable,
  OperationId,
  HttpMethod,
  ParameterLocation,
  TOKEN_VARIABLE,
  normalizeOpenApiAuthInputs,
  type Authentication,
  type AuthenticationInput,
  type APIKeyAuthentication,
} from "./types";
// Request-shaped authoring: `headers: { Authorization: ["Bearer ", variable("token")] }`.
export { variable, type ApiKeyAuthTemplate } from "@executor-js/sdk/http-auth";

export { migrateOpenApiAuthConfig } from "./migrate-config";
