/** Effect-native source generators. The host owns catalog lookup, auth discovery and deployment. */
export {
  TemplateError,
  TemplateErrorCode,
  SkippedOperation,
  skippedOperationSummary,
  type RemoteAuth,
  type StdioAppInput,
} from "./contracts/templates.ts";
export type { OpenApiImport } from "./contracts/openapi.ts";
export { generateRemoteApp } from "./implementation/remote.ts";
export { generateStdioApp } from "./implementation/stdio.ts";
export { generateOpenApiApp, compileOpenApi } from "./implementation/openapi.ts";
