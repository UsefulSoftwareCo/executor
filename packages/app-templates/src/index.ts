/** Effect-native source generators. The host owns catalog lookup, auth discovery and deployment. */
export { TemplateError, TemplateErrorCode } from "./contracts/templates.ts";
export { generateMcpSource, type McpSourceAccess } from "./implementation/mcp.ts";
export { appsVersion, packageFile } from "./implementation/files.ts";
