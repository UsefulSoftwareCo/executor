import { Cause, Effect, ErrorReporter, Option, Schema, SchemaAST } from "effect";
import { HttpServerResponse } from "effect/http";
import { McpSchema } from "effect/ai";
import {
  AppEvaluationFailed,
  CallFailure,
  callFailurePresentation,
  hostObservedEvaluation,
  ToolCallFailed,
  ToolListingTimedOut,
  ToolSearchStale,
  ToolSearchUnavailable,
} from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { maxApiErrorInstructionsLength, maxApiErrorMessageLength } from "apps/contracts";
import type { CodeMode } from "@opencode-ai/codemode";
import {
  AppDiscoveryTimedOut,
  FailureReference,
  McpErrorResponse,
  type McpFailurePhase,
} from "../contracts/execute.ts";

const encodeResponse = Schema.encodeSync(Schema.fromJsonString(McpErrorResponse));

/** An app's own error detail can make an explanation long; shorten it rather than drop it. */
const bounded = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/**
 * A product error's curated presentation. Arbitrary Error.message and causes never pass; an API's
 * declared recovery passes only as the error presents it, after any instruction of Executor's.
 * A tool call's failure is presented as the SDK composes it for every surface: one of a call that
 * may have written (`mayHaveWritten`) leads with Executor's instruction not to repeat it, and no
 * cause advises another call. A query's refusal without a presentation is named by its code.
 */
const presentation = (error: Error): Option.Option<McpErrorResponse> => {
  const schema = error.constructor;
  if (!Schema.isSchema(schema)) return Option.none();
  const call = Schema.is(CallFailure)(error) ? error : undefined;
  // Product errors carry a curated description, recovery and retry policy, so agents can act on
  // deterministic failures such as a missing account instead of retrying them.
  const product = UserFacingError.is(error) ? error : undefined;
  const presented = call === undefined ? product : callFailurePresentation(call);
  if (presented === undefined) return Option.none();
  // An error the app's API declared keeps its own code and status; its message is the description.
  const declared = Schema.is(ToolCallFailed)(error) ? error.response : undefined;
  return Schema.decodeUnknownOption(McpErrorResponse)({
    code: declared?.code ?? call?._tag ?? product?.code,
    // Otherwise this is the Executor API status; an upstream status remains in the explanation.
    status:
      declared === undefined
        ? SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast)
        : declared.status,
    message: bounded(presented.description, maxApiErrorMessageLength),
    recovery: {
      action: presented.recovery.action,
      instructions: bounded(presented.recovery.instructions, maxApiErrorInstructionsLength),
    },
    retryable: presented.retryable ?? false,
  });
};
/**
 * Where a failure reached the agent: whether Executor was listing an app's tools or calling one,
 * and the trace of the request that met it.
 */
export interface FailureSite {
  readonly operation: "discover" | "call";
  readonly reference: string | undefined;
}
/**
 * The current request's trace ID, the reference of each failure it meets. The host's tracer
 * creates it or continues the client's, so nothing an app returns can set or change it.
 */
export const failureReference: Effect.Effect<string | undefined> = Effect.option(
  Effect.currentSpan,
).pipe(
  Effect.map((span) =>
    Option.isSome(span) && Schema.is(FailureReference)(span.value.traceId)
      ? span.value.traceId
      : undefined,
  ),
);
/**
 * The phase a failure stopped, from what Executor itself observed: what it was doing when it met
 * the failure, `evaluate` only when its own code found the app's definition could not load, and
 * `discover` for its own listing deadlines. The app's code can raise any other failure, including
 * one that names a phase or says the definition failed, so the phase an app reports stays in
 * the message as the app's account and never chooses this one.
 */
const phaseOf = (error: Error, operation: FailureSite["operation"]): McpFailurePhase => {
  if (Schema.is(AppEvaluationFailed)(error) && hostObservedEvaluation(error)) return "evaluate";
  if (
    Schema.is(ToolListingTimedOut)(error) ||
    Schema.is(AppDiscoveryTimedOut)(error) ||
    Schema.is(ToolSearchUnavailable)(error) ||
    Schema.is(ToolSearchStale)(error)
  )
    return "discover";
  return operation;
};
/** A product error's presentation with the phase it stopped and its request's reference. */
const located = (error: Error, site: FailureSite): Option.Option<McpErrorResponse> =>
  presentation(error).pipe(
    Option.map((response) => ({
      ...response,
      phase: phaseOf(error, site.operation),
      ...(site.reference === undefined ? {} : { reference: site.reference }),
    })),
  );
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
/**
 * One line for agents: code, status, message, the declared recovery action and whether repeating
 * the same call unchanged may help, then the phase the failure stopped and the reference a user
 * can share to find it. A corrected call is a new call whatever this says.
 */
const summary = ({
  code,
  status,
  message,
  recovery,
  retryable,
  phase,
  reference,
}: McpErrorResponse) =>
  `${code} (HTTP ${status}): ${message}${recovery === undefined ? "" : ` Recovery: ${recovery.action}`} Retryable (unchanged call): ${retryable ? "yes" : "no"}.${phase === undefined ? "" : ` Phase: ${phase}.`}${reference === undefined ? "" : ` Reference: ${reference}.`}`;

/**
 * Preserve bounded, curated framework recovery as JSON, which a program can read from a caught
 * tool error; unknown errors expose only their schema identifier.
 */
export const diagnostic = (error: Error, site: FailureSite): string =>
  Option.match(located(error, site), {
    onSome: encodeResponse,
    onNone: () => identifier(error),
  });

/** The same presentation as a single readable line, for failures agents read but never parse. */
export const diagnosticSummary = (error: Error, site: FailureSite): string =>
  Option.match(located(error, site), { onSome: summary, onNone: () => identifier(error) });

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
 * A declared recovery action and retry policy are appended to the summary line; full recovery stays
 * in `response`.
 */
export const executionDiagnostic = <A extends CodeMode.Result>(execution: A) =>
  execution.ok ? execution : { ...execution, error: failureDetail(execution.error) };

/** One failure as agents read it: a tool or execution failure carrying our JSON gains its summary. */
export const failureDetail = <A extends Pick<CodeMode.Diagnostic, "kind" | "message">>(
  error: A,
) => {
  if (error.kind !== "ToolFailure" && error.kind !== "ExecutionFailure") return error;
  const response = Schema.decodeUnknownOption(Schema.fromJsonString(McpErrorResponse))(
    error.message,
  );
  if (Option.isNone(response)) return error;
  return { ...error, message: summary(response.value), response: response.value };
};
