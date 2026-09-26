import { Option, Schema, SchemaAST } from "effect";
import {
  AppEvaluationFailed,
  AppProviderFailed,
  InputInvalid,
  ToolCallFailed,
} from "@executor-js/sdk/core";
import { ApiErrorResponse } from "apps/contracts";
import { CodeMode } from "@opencode-ai/codemode";

const AppFailure = Schema.Union([AppProviderFailed, AppEvaluationFailed]);

/** Preserve bounded, curated framework recovery; unknown errors expose only their schema identifier. */
export const diagnostic = (error: Error): string => {
  const encode = Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse));
  const tool = Schema.decodeUnknownOption(ToolCallFailed)(error);
  if (Option.isSome(tool)) {
    if (tool.value.response !== undefined) return encode(tool.value.response);
    // The SDK sets a fixed, safe reason for failures without a declared response.
    const response = Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "ToolCallFailed",
      status: 502,
      message: tool.value.reason,
      recovery: {
        action: "Check whether the tool already made changes before retrying.",
        instructions:
          "The tool failed after it started, so external effects may already have occurred. Retry safety is not implied. Inspect current state with a safe read before repeating the call.",
      },
    });
    if (Option.isSome(response)) return encode(response.value);
  }
  const input = Schema.decodeUnknownOption(InputInvalid)(error);
  if (Option.isSome(input)) {
    // Problems name input paths and expected shapes; supplied values are never included.
    const response = Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "InputInvalid",
      status: 422,
      message: `Input failed validation: ${input.value.problems.join("; ")}`.slice(0, 4096),
      recovery: {
        action: "Fix the listed input fields and call the tool again.",
        instructions:
          "The tool did not run. Compare the input with the tool's signature from tools.search before retrying.",
      },
    });
    if (Option.isSome(response)) return encode(response.value);
  }
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
    if (Option.isSome(response)) return encode(response.value);
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
