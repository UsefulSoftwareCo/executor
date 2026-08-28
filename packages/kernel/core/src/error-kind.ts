/**
 * Enumerable classification of a failed sandbox execution, derived from the
 * structured error the runtime already holds (the thrown error's `name`, or
 * the runtime's own typed failure). Carried on `ExecuteResult.errorKind`
 * beside the descriptive `error` string so telemetry can count failure
 * classes as identifiers without ever recording message content.
 */
export type ExecuteErrorKind =
  | "syntax_error"
  | "type_error"
  | "reference_error"
  | "range_error"
  | "tool_error"
  | "timeout"
  | "resource_limit"
  | "serialization_error"
  | "thrown";

const KIND_BY_ERROR_NAME: Readonly<Record<string, ExecuteErrorKind>> = {
  SyntaxError: "syntax_error",
  TypeError: "type_error",
  ReferenceError: "reference_error",
  RangeError: "range_error",
  ExecutionToolError: "tool_error",
  ExecutionTimeoutError: "timeout",
  DataCloneError: "serialization_error",
};

/**
 * Classify an error thrown inside the sandbox by its `name`. Runtimes tag
 * their own conditions with dedicated names (`ExecutionToolError` for a
 * failed tool-dispatch rethrow, `ExecutionTimeoutError` for the in-sandbox
 * deadline); anything unrecognized is the script's own `throw`.
 */
export const classifyThrownExecuteError = (
  errorName: string | null | undefined,
): ExecuteErrorKind => (errorName != null ? KIND_BY_ERROR_NAME[errorName] : undefined) ?? "thrown";
