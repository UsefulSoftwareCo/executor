/** OpenAPI compilation shared by runtime sources and host templates. */
export * from "./contracts/openapi-document.ts";
export { compileOpenApiDocument } from "./implementation/openapi-compile.ts";
export { openApiDocument, type OpenApiDocument } from "./implementation/openapi-document.ts";
