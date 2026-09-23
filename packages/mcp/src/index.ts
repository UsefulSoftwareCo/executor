/** Shared Effect MCP surface. Authentication and authorization belong to the host. */
export * from "./contracts/backend.ts";
export * from "./contracts/execute.ts";
export * from "./contracts/elicitation.ts";
export * from "./contracts/skills.ts";
export * from "./contracts/tools.ts";
export { execute } from "./implementation/execute.ts";
export { mcp, makeMcp } from "./implementation/server.ts";
export { skills } from "./implementation/skills.ts";
export { makeExecutions } from "./implementation/executions.ts";

export * from "./contracts/browser.ts";
export * from "./contracts/browser-tools.ts";

export * from "./contracts/targets.ts";
