import { Context } from "effect";

export const McpRequestAttributes = Context.Reference<Readonly<Record<string, string>>>(
  "@executor-js/mcp/McpRequestAttributes",
  { defaultValue: () => ({}) },
);
