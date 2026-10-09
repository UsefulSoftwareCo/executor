import { Cause, Effect, ErrorReporter, Option, Schema, SchemaAST } from "effect";
import { HttpServerResponse } from "effect/http";
import { McpSchema } from "effect/ai";
import { InputInvalid, mcpFailurePresentation, ToolCallFailed } from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import {
  ApiErrorResponse,
  maxApiErrorInstructionsLength,
  maxApiErrorMessageLength,
} from "apps/contracts";
import type { CodeMode } from "@opencode-ai/codemode";

const encodeResponse = Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse));

/** An app's own error detail can make an explanation long; shorten it rather than drop it. */
const bounded = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/** A product error's curated presentation. Arbitrary Error.message, causes and authored recovery never pass. */
const presentation = (error: Error): Option.Option<typeof ApiErrorResponse.Type> => {
  const tool = Schema.decodeUnknownOption(ToolCallFailed)(error);
  if (Option.isSome(tool)) {
    if (tool.value.response !== undefined) return Option.some(tool.value.response);
    // The reason is a fixed SDK text, the app's own bounded, secret-free error message, or its
    // MCP server's failure with the server's bounded JSON-RPC error.
    return Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "ToolCallFailed",
      status: 502,
      message: bounded(tool.value.reason, maxApiErrorMessageLength),
      recovery:
        tool.value.mcp !== undefined
          ? mcpFailurePresentation(tool.value.mcp).recovery
          : tool.value.failure === undefined
            ? {
                action: "Check whether the tool already made changes before retrying.",
                instructions:
                  "The tool failed after it started, so external effects may already have occurred. Retry safety is not implied. Inspect current state with a safe read before repeating the call.",
              }
            : tool.value.failure.source === "service"
              ? {
                  action: "Check the API's response and the app's OpenAPI document, then retry.",
                  instructions:
                    "An API the app calls failed in a way its OpenAPI document does not describe. The message names the operation's method and templated path, and the response's status, media type and length; the response body is not shown. Check that the path and parameters match the API, the API's own logs or status, and whether the document declares this error. Retry safety is not implied; inspect current state with a safe read before repeating the call.",
                }
              : tool.value.failure.source === "storage"
                ? {
                    action: "Change the operation so it stays within app data rules, then retry.",
                    instructions: `The app's data storage rejected this operation (${tool.value.failure.code ?? tool.value.failure.errorName}). Read the message, change the app's query or mutation to respect it, deploy, and verify the call succeeds. A failed mutation's writes were rolled back, but any external effects it made may already have occurred.`,
                  }
                : {
                    action: "Fix the input or the app code that threw this error, then retry.",
                    instructions:
                      "The app's own code threw this error; the message is the app's text. Decide from it whether the input was wrong or the app has a bug. Fix the input, or find where the app throws it and deploy a fix. A failed mutation's writes were rolled back, but any external effects it made may already have occurred.",
                  },
    });
  }
  const input = Schema.decodeUnknownOption(InputInvalid)(error);
  if (Option.isSome(input)) {
    // Problems name input paths and what the schema expects there; supplied values are never included.
    return Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "InputInvalid",
      status: 422,
      message: `Input failed validation: ${input.value.problems.join("; ")}`.slice(0, 4096),
      recovery: {
        action: "Change the input to the shape each problem expects, then call the tool again.",
        instructions:
          "The tool did not run. Each problem names an input path and what that path expects: a type, the values the schema allows, an object's keys (? marks an optional key, ... marks other keys allowed), an unexpected key to remove, or the alternatives a union accepts. For a union, pick one alternative and set the key that tells them apart; the problems after it are for the closest alternative. Nest each field where the tool's input type from tools.search or tools.search.describe places it, then retry.",
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
    message: bounded(error.description, maxApiErrorMessageLength),
    recovery: {
      action: error.recovery.action,
      instructions: bounded(error.recovery.instructions, maxApiErrorInstructionsLength),
    },
  });
};
const identifier = (error: Error) => {
  const schema = error.constructor;
  return Schema.isSchema(schema) ? (SchemaAST.resolveIdentifier(schema.ast) ?? "Error") : "Error";
};
/**
 * Report a failure an MCP tool answers with as data, as the same failure of a REST request reports.
 * The host's reporter decides what is an incident, such as skipping client errors, and records it
 * without the app's text.
 */
export const reportFailure = (error: Error): Effect.Effect<void> =>
  ErrorReporter.report(Cause.fail(error));
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

/**
 * Refuse an MCP HTTP request before protocol dispatch. Clients print the response body after
 * their own prefix, such as "Error POSTing to endpoint:", so an empty body hides the cause. The
 * body is a JSON-RPC error without a request ID, carrying the error's summary and presentation.
 * Its code is -32600, as for the transport's own rejections: the MCP specification defines no
 * code for a refused request and says new implementations should not use -32000 to -32019.
 */
export const refusedMcpRequest = (
  error: UserFacingError,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Option.match(presentation(error), {
    onNone: () => Effect.die(new Error(`${error.code} has no valid API presentation`)),
    onSome: (response) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: McpSchema.INVALID_REQUEST_ERROR_CODE,
              message: summary(response),
              data: response,
            },
          },
          { status: response.status },
        ),
      ),
  });

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
