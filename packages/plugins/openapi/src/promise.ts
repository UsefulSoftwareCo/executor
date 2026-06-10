export { openApiPlugin } from "./sdk/plugin";
export type {
  OpenApiPluginOptions,
  OpenApiPluginExtension,
  OpenApiSpecConfig,
  OpenApiSpecInput,
  OpenApiPreviewInput,
} from "./sdk/plugin";

// Auth-template authoring helpers. Author apikey methods as canonical
// placements, or request-shaped: `headers: { Authorization: ["Bearer ",
// variable("token")] }` — both normalize to the same stored model.
export { TOKEN_VARIABLE } from "./sdk/types";
export type { Authentication, AuthenticationInput, APIKeyAuthentication } from "./sdk/types";
export { variable, type ApiKeyAuthTemplate } from "@executor-js/sdk/http-auth";
