import { Option, Schema, SchemaAST } from "effect";
import { InputInvalid, ToolCallFailed } from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ApiErrorResponse } from "apps/contracts";
import { CodeMode } from "@opencode-ai/codemode";

const encodeResponse = Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse));

/** A product error's curated presentation. Arbitrary Error.message, causes and authored recovery never pass. */
const presentation = (error: Error): Option.Option<typeof ApiErrorResponse.Type> => {
  const tool = Schema.decodeUnknownOption(ToolCallFailed)(error);
  if (Option.isSome(tool)) {
    if (tool.value.response !== undefined) return Option.some(tool.value.response);
    // The SDK sets a fixed, safe reason for failures without a declared response.
    return Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "ToolCallFailed",
      status: 502,
      message: tool.value.reason,
      recovery: {
        action: "Check whether the tool already made changes before retrying.",
        instructions:
          "The tool failed after it started, so external effects may already have occurred. Retry safety is not implied. Inspect current state with a safe read before repeating the call.",
      },
    });
  }
  const input = Schema.decodeUnknownOption(InputInvalid)(error);
  if (Option.isSome(input)) {
    // Problems name input paths and expected shapes; supplied values are never included.
    return Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "InputInvalid",
      status: 422,
      message: `Input failed validation: ${input.value.problems.join("; ")}`.slice(0, 4096),
      recovery: {
        action: "Fix the listed input fields and call the tool again.",
        instructions:
          "The tool did not run. Compare the input with the tool's signature from tools.search before retrying.",
      },
    });
  }
  const schema = error.constructor;
  // Product errors carry a curated description and recovery, so agents can act on
  // deterministic failures such as a missing account instead of retrying them.
  if (!UserFacingError.is(error) || !Schema.isSchema(schema)) return Option.none();
  return Schema.decodeUnknownOption(ApiErrorResponse)({
    code: error.code,
    // This is the Executor API status; an upstream status remains in the explanation.
    status: SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast),
    message: error.description,
    recovery: error.recovery,
  });
};
const identifier = (error: Error) => {
  const schema = error.constructor;
  return Schema.isSchema(schema) ? (SchemaAST.resolveIdentifier(schema.ast) ?? "Error") : "Error";
};
/** One line for agents: code, status, message and the declared recovery action. */
const summary = ({ code, status, message, recovery }: typeof ApiErrorResponse.Type) =>
  `${code} (HTTP ${status}): ${message}${recovery === undefined ? "" : ` Recovery: ${recovery.action}`}`;

/**
 * Preserve bounded, curated framework recovery as JSON, which a program can read from a caught
 * tool error; unknown errors expose only their schema identifier.
 */
export const diagnostic = (error: Error): string =>
  Option.match(presentation(error), { onSome: encodeResponse, onNone: () => identifier(error) });

/** The same presentation as a single readable line, for failures agents read but never parse. */
export const diagnosticSummary = (error: Error): string =>
  Option.match(presentation(error), { onSome: summary, onNone: () => identifier(error) });

/** CodeMode transports tool errors as messages, including inside agent try/catch.
 * Decode our safe JSON projection back into structured MCP details for uncaught failures.
 * A declared recovery action is appended to the summary line; full recovery stays in `response`.
 */
export const executionDiagnostic = <A extends CodeMode.Result>(execution: A) => {
  if (
    execution.ok ||
    (execution.error.kind !== "ToolFailure" && execution.error.kind !== "ExecutionFailure")
  )
    return execution;
  const response = Schema.decodeUnknownOption(Schema.fromJsonString(ApiErrorResponse))(
    execution.error.message,
  );
  if (Option.isNone(response)) return execution;
  return {
    ...execution,
    error: { ...execution.error, message: summary(response.value), response: response.value },
  };
};
