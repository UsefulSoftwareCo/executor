export { TemplateError, TemplateErrorCode } from "./contracts/templates.ts";
export {
  generateMcpSource,
  type McpSourceAccess,
  type McpSourceOptions,
} from "./implementation/mcp.ts";
export { graphqlAppSource, openapiAppSource } from "./implementation/protocol-apps.ts";
export type {
  CredentialPlacement,
  GeneratedAuthMethod,
  GeneratedFixedAccount,
  GeneratedHealthCheck,
  GeneratedToolRules,
  ProtocolAppOptions,
} from "./contracts/templates.ts";
export { appsVersion, packageFile } from "./implementation/files.ts";
