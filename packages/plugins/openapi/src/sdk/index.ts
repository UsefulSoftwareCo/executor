export { parse, resolveSpecText, fetchSpecText } from "./parse";
export {
  applySpecOverrides,
  JsonPatchOperationSchema,
  SpecOverridesSchema,
  type JsonPatchOperation,
  type SpecOverrides,
} from "./spec-overrides";
export { extract, streamOperationBindingsFromStructure } from "./extract";
export {
  structuralSplit,
  isStreamableSpec,
  indexSchemas,
  collectReferencedSchemas,
  parseEntry,
  parseHead,
  parseSmallComponents,
  type SpecStructure,
  type ByteRange,
  type KeepPathItem,
} from "./split";
export {
  invoke,
  invokeWithLayer,
  buildRequest,
  annotationsForOperation,
  RESPONSE_BODY_TIMEOUT_MS,
  RESPONSE_HEADERS_TIMEOUT_MS,
  type InvokeOptions,
} from "./invoke";
export {
  buildDefsJsonStreaming,
  checkHealthOpenApi,
  compileAndPersistOpenApiOperations,
  compileAndPersistOpenApiSpec,
  compileAndPersistOpenApiSpecStreaming,
  compileOpenApiDocument,
  compileOpenApiSpec,
  extractOpenApiUpstreamMessage,
  invokeOpenApiBackedTool,
  listHealthCheckCandidatesOpenApi,
  loadOpenApiSpecText,
  normalizeOpenApiRefs,
  openApiStoredOperationsFromCompiled,
  openApiToolDefsFromCompiled,
  resolveOpenApiBackedAnnotations,
  resolveOpenApiBackedTools,
  validateOpenApiBackedToolArgs,
  type CompiledOpenApiSpec,
  type OpenApiPersistResult,
} from "./backing";
export type { ParsedDocument } from "./parse";
export {
  openApiPlugin,
  type OpenApiSpecConfig,
  type OpenApiConfigureInput,
  type OpenApiSpecInput,
  type OpenApiPreviewInput,
  type OpenApiPluginExtension,
  type OpenApiPluginOptions,
} from "./plugin";
export {
  resolveSpecFormatAdapter,
  type ConvertedSpec,
  type DerivedIdentity,
  type SpecFetchCredentials,
  type SpecFetchInput,
  type SpecFormatAdapter,
} from "./spec-format";
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
  resolveServerUrl,
  substituteUrlVariables,
  preferredContent,
} from "./openapi-utils";

export {
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiInvocationError,
  OpenApiOAuthError,
  OpenApiSpecOverrideError,
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

export {
  openApiOutputSchemaDataMigration,
  runSqliteOpenApiOutputSchemaMigration,
  unwrapOpenApiTransportEnvelope,
} from "./output-schema-migration";

export {
  openApiNdjsonOutputDataMigration,
  runSqliteNdjsonOutputMigration,
} from "./ndjson-output-migration";

export { openApiSpecBlobDataMigration } from "./spec-blob-migration";
