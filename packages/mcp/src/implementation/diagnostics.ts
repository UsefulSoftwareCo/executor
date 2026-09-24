import { Option, Schema, SchemaAST } from "effect";
import { ToolCallFailed } from "@executor-js/sdk/core";
import { ApiErrorResponse } from "apps/contracts";
import { CodeMode } from "@opencode-ai/codemode";

/** Schema identifiers are static; an error's name, message and fields can contain private upstream data. */
export const diagnostic = (error: Error): string => {
  const tool = Schema.decodeUnknownOption(ToolCallFailed)(error);
  if (Option.isSome(tool) && tool.value.response !== undefined)
    return Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse))(tool.value.response);
  const schema = error.constructor;
  return Schema.isSchema(schema) ? (SchemaAST.resolveIdentifier(schema.ast) ?? "Error") : "Error";
};

/** CodeMode transports tool errors as messages, including inside agent try/catch.
 * Decode our safe JSON projection back into structured MCP details for uncaught failures.
 */
export const executionDiagnostic = (execution: CodeMode.Result) => {
  if (execution.ok || execution.error.kind !== "ToolFailure") return execution;
  const response = Schema.decodeUnknownOption(Schema.fromJsonString(ApiErrorResponse))(
    execution.error.message,
  );
  if (Option.isNone(response)) return execution;
  return {
    ...execution,
    error: {
      ...execution.error,
      message: `${response.value.code} (HTTP ${response.value.status}): ${response.value.message}`,
      response: response.value,
    },
  };
};
