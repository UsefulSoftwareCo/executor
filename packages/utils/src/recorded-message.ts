import { Predicate } from "effect";

/**
 * The fixed sentence traces and error reports record for a tagged error, beside its tag. Telemetry
 * records no other text from a tagged error: one that declares no sentence is recorded by its tag
 * alone (`@executor-js/telemetry/recorded-failure`). Declare one from fixed text and closed fields
 * only, never from a value the caller supplied (a slug, a name, a tool name, an argument's key),
 * an app's own text or a service's reply. That text still reaches the caller the error is for.
 * `ApiError` and `UserFacingError` declare a fixed message for you; a message derived from fields
 * declares `recorded`.
 */
export const RecordedMessage: unique symbol = Symbol.for("@executor-js/utils/RecordedMessage");

/** The fixed sentence an error declares for telemetry, if it declares one. */
export const recordedMessage = (error: unknown): string | undefined => {
  if (Predicate.hasProperty(error, RecordedMessage)) {
    const message = error[RecordedMessage];
    return typeof message === "string" ? message : undefined;
  }
  return protocolErrorMessage(error) ?? sqlErrorMessage(error);
};

/**
 * Declare a recorded message on one error that Executor did not define the text of, such as an
 * error decoded from an app's reply. An error class's own declaration is kept. The error's fields
 * and wire encoding are unchanged.
 */
export const recordAs = <E>(error: E, message: string): E => {
  if (typeof error === "object" && error !== null && recordedMessage(error) === undefined)
    Object.defineProperty(error, RecordedMessage, { value: message });
  return error;
};

const jsonRpcMeanings: Readonly<Record<number, string>> = {
  [-32700]: "Parse error",
  [-32600]: "Invalid request",
  [-32601]: "Method not found",
  [-32602]: "Invalid params",
  [-32603]: "Internal error",
  [-32002]: "Resource not found",
};

/**
 * Effect's MCP server answers a request it refuses with a JSON-RPC `ProtocolError` whose message
 * quotes the request: "Tool '<name>' not found", "Invalid parameters for tool '<name>': <argument
 * paths>", "Resource '<uri>' not found". Its class is internal to Effect, so it cannot declare a
 * recorded message itself. It records a listed code and its meaning instead, and which of Effect's
 * two tool refusals it was; no text from the message, and no unlisted code, is kept.
 */
const protocolErrorMessage = (error: unknown): string | undefined => {
  if (
    !Predicate.isTagged(error, "ProtocolError") ||
    !Predicate.hasProperty(error, "code") ||
    typeof error.code !== "number" ||
    !Predicate.hasProperty(error, "message") ||
    !Predicate.isString(error.message)
  )
    return undefined;
  const code = error.code;
  const refusal = /^Tool '.*' not found$/s.test(error.message)
    ? ": the requested tool does not exist"
    : error.message.startsWith("Invalid parameters for tool '")
      ? ": the tool's arguments failed validation"
      : "";
  const meaning = jsonRpcMeanings[code];
  const kind =
    meaning === undefined ? "JSON-RPC error with an unlisted code" : `${meaning} (${code})`;
  return kind + refusal;
};

/** Effect's SQL failure kinds (`SqlErrorReason`). */
const sqlReasons: ReadonlySet<string> = new Set([
  "ConnectionError",
  "AuthenticationError",
  "AuthorizationError",
  "SqlSyntaxError",
  "UniqueViolation",
  "ConstraintError",
  "DeadlockError",
  "SerializationError",
  "LockTimeoutError",
  "StatementTimeoutError",
  "UnknownError",
]);

/** The fixed messages `@effect/sql-pg` gives its failures. */
const sqlMessages: ReadonlySet<string> = new Set(
  [
    "A pipelined query completed out of order",
    "Connection closed",
    "Connection closed during startup",
    "Connection is closed",
    "Connection timed out",
    "Failed to connect",
    "Failed to decode row",
    "Failed to encode query",
    "Failed to negotiate TLS",
    "Failed to parse SSLRequest error response",
    "Failed to parse server messages",
    "Failed to parse server response",
    "Failed to write query",
    "Failed to write query batch",
    "Invalid SSLRequest response",
    "MD5 authentication failed",
    "No password configured",
    "Protocol desync",
    "Query cancellation timed out",
    "Query failed",
    "SCRAM authentication failed",
    "SCRAM exchange did not complete",
    "SCRAM server verification failed",
    "Server refused TLS",
    "Socket error",
    "Stream cancellation timed out",
    "The server reported an error",
    "Unsupported authentication method",
  ].map((message) => `PgConnection: ${message}`),
);

/**
 * Effect's `SqlError` is its class too. Its reason's message is the driver's: `@effect/sql-pg`
 * states fixed sentences, but a reason's message and cause can carry the server's error, which
 * quotes the values in a statement. It records its kind and a listed sentence only; no other text.
 */
const sqlErrorMessage = (error: unknown): string | undefined => {
  if (!Predicate.isTagged(error, "SqlError") || !Predicate.hasProperty(error, "reason"))
    return undefined;
  const reason = error.reason;
  const kind =
    Predicate.hasProperty(reason, "_tag") &&
    Predicate.isString(reason._tag) &&
    sqlReasons.has(reason._tag)
      ? reason._tag
      : "an unlisted kind";
  const message =
    Predicate.hasProperty(reason, "message") &&
    Predicate.isString(reason.message) &&
    sqlMessages.has(reason.message)
      ? `: ${reason.message}`
      : "";
  return `The database failed (${kind})${message}`;
};
