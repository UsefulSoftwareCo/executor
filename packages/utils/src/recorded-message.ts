import { Predicate } from "effect";

export const RecordedMessage: unique symbol = Symbol.for("@executor-js/utils/RecordedMessage");

export const recordedMessage = (error: unknown): string | undefined => {
  if (Predicate.hasProperty(error, RecordedMessage)) {
    const message = error[RecordedMessage];
    return typeof message === "string" ? message : undefined;
  }
  return protocolErrorMessage(error) ?? sqlErrorMessage(error);
};

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
