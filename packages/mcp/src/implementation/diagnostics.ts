import { Option, Schema, SchemaAST } from "effect";
import { AppEvaluationFailed, AppProviderFailed, ToolCallFailed } from "@executor-js/sdk/core";
import { ApiErrorResponse } from "apps/contracts";
import { CodeMode } from "@opencode-ai/codemode";

const AppFailure = Schema.Union([AppProviderFailed, AppEvaluationFailed]);

/** Preserve bounded, curated framework recovery; unknown errors expose only their schema identifier. */
export const diagnostic = (error: Error): string => {
  const tool = Schema.decodeUnknownOption(ToolCallFailed)(error);
  if (Option.isSome(tool) && tool.value.response !== undefined)
    return Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse))(tool.value.response);
  // Decode only the known framework errors to reconstruct their curated presentation.
  // Do not forward arbitrary Error.message, causes, or authored recovery fields.
  const app = Schema.decodeUnknownOption(AppFailure)(error);
  if (Option.isSome(app)) {
    const response = Schema.decodeUnknownOption(ApiErrorResponse)({
      code: app.value.code,
      // This is the Executor API status; upstream status remains in the explanation.
      status: 502,
      message: app.value.description,
      recovery: app.value.recovery,
    });
    if (Option.isSome(response))
      return Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse))(response.value);
  }
  const schema = error.constructor;
  return Schema.isSchema(schema) ? (SchemaAST.resolveIdentifier(schema.ast) ?? "Error") : "Error";
};

/** CodeMode transports tool errors as messages, including inside agent try/catch.
 * Decode our safe JSON projection back into structured MCP details for uncaught failures.
 * A declared recovery action is appended to the summary line; full recovery stays in `response`.
 */
export const executionDiagnostic = (execution: CodeMode.Result) => {
  if (execution.ok || execution.error.kind !== "ToolFailure") return execution;
  const response = Schema.decodeUnknownOption(Schema.fromJsonString(ApiErrorResponse))(
    execution.error.message,
  );
  if (Option.isNone(response)) return execution;
  const { code, status, message, recovery } = response.value;
  return {
    ...execution,
    error: {
      ...execution.error,
      message: `${code} (HTTP ${status}): ${message}${recovery === undefined ? "" : ` Recovery: ${recovery.action}`}`,
      response: response.value,
    },
  };
};
