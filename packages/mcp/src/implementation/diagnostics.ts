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

const bounded = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

const presentation = (error: Error): Option.Option<McpErrorResponse> => {
  const schema = error.constructor;
  if (!Schema.isSchema(schema)) return Option.none();
  const call = Schema.is(CallFailure)(error) ? error : undefined;
  const product = UserFacingError.is(error) ? error : undefined;
  const presented = call === undefined ? product : callFailurePresentation(call);
  if (presented === undefined) return Option.none();
  const declared = Schema.is(ToolCallFailed)(error) ? error.response : undefined;
  return Schema.decodeUnknownOption(McpErrorResponse)({
    code: declared?.code ?? call?._tag ?? product?.code,
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
export interface FailureSite {
  readonly operation: "discover" | "call";
  readonly reference: string | undefined;
}
export const failureReference: Effect.Effect<string | undefined> = Effect.option(
  Effect.currentSpan,
).pipe(
  Effect.map((span) =>
    Option.isSome(span) && Schema.is(FailureReference)(span.value.traceId)
      ? span.value.traceId
      : undefined,
  ),
);
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
export const reportFailure = (error: Error): Effect.Effect<void> =>
  ErrorReporter.report(Cause.fail(error));
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

export const diagnostic = (error: Error, site: FailureSite): string =>
  Option.match(located(error, site), {
    onSome: encodeResponse,
    onNone: () => identifier(error),
  });

export const diagnosticSummary = (error: Error, site: FailureSite): string =>
  Option.match(located(error, site), { onSome: summary, onNone: () => identifier(error) });

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

export const executionDiagnostic = <A extends CodeMode.Result>(execution: A) =>
  execution.ok ? execution : { ...execution, error: failureDetail(execution.error) };

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
