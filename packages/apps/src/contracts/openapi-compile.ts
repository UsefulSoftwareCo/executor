/** Shared OpenAPI compilation diagnostics. */
import { Schema } from "effect";

/** Which part of an OpenAPI document could not be compiled into tools. */
export const OpenapiCompileErrorCode = Schema.Literals([
  "server_protocol",
  "server_url",
  "external_reference",
  "circular_reference",
  "schema_keyword",
  "schema_reference",
  "missing_component",
  "openapi_version",
  "auth_helper",
  "auth_missing",
  "operation_path",
  "operation_method",
  "duplicate_operation",
  "server_missing",
  "multiple_hosts",
  "parameter_encoding",
  "parameter_style",
  "request_body",
  "combined_oauth",
  "auth_method",
  "event_stream",
  "input_schema",
  "no_operations",
  "no_supported_operations",
  "invalid_document",
  "source_generation",
  "authoring_reference",
]);

/** A declared operation the importer left out, and why. */
export const OpenapiSkippedOperation = Schema.Struct({
  /** The tool name the operation would have; reading that tool reports why it is missing. */
  name: Schema.String,
  /** The HTTP method, such as `GET`. */
  method: Schema.String,
  /** The path as the definition declares it. */
  path: Schema.String,
  code: OpenapiCompileErrorCode,
  reason: Schema.String,
});
export type OpenapiSkippedOperation = typeof OpenapiSkippedOperation.Type;

/** Distinct skip reasons the message names; the structured `skipped` field keeps every one. */
const listedReasons = 8;
/** Each listed reason is cut to this many characters, so the message stays within failure bounds. */
const reasonLength = 240;
const cut = (text: string) =>
  text.length <= reasonLength ? text : `${text.slice(0, reasonLength - 1)}…`;

/**
 * The reason, then which operations it affected or, when causes differ, each distinct skip reason
 * with one example operation and how many more share it.
 */
const compileMessage = (error: OpenapiCompileError) => {
  const skipped = error.skipped ?? [];
  if (skipped.length === 0) return error.reason;
  const groups = new Map<string, { first: OpenapiSkippedOperation; count: number }>();
  for (const operation of skipped) {
    const key = JSON.stringify([operation.code, operation.reason]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { first: operation, count: 1 });
    else group.count++;
  }
  const example = ({ first, count }: { first: OpenapiSkippedOperation; count: number }) =>
    `${first.method} ${first.path}${count > 1 ? ` and ${count - 1} more` : ""}`;
  const [only, ...others] = groups.values();
  if (
    only !== undefined &&
    others.length === 0 &&
    only.first.code === error.code &&
    only.first.reason === error.reason
  )
    return `${error.reason} Left out: ${example(only)}.`;
  const listed = [...groups.values()].slice(0, listedReasons);
  const rest = groups.size - listed.length;
  return `${error.reason} Left out: ${listed
    .map(
      (group) =>
        `${example(group)} (${group.first.code}: ${cut(group.first.reason.replace(/\.$/, ""))})`,
    )
    .join("; ")}${rest > 0 ? `; and ${rest} other reasons` : ""}.`;
};

/**
 * A safe generation failure. `reason` explains the cause; `skipped` lists the declared operations
 * it left out and why, and `origins` the origins operations resolve to when none of them matches
 * the allowed origin. Reading one left-out tool fails with this error for that operation alone.
 */
export class OpenapiCompileError extends Schema.TaggedError<OpenapiCompileError>()(
  "OpenapiCompileError",
  {
    code: OpenapiCompileErrorCode,
    reason: Schema.String,
    skipped: Schema.optionalKey(Schema.Array(OpenapiSkippedOperation)),
    origins: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  override get message() {
    return compileMessage(this);
  }
}

/** A tool a generated OpenAPI router exposes, read from the definition alone. */
export const OpenapiToolName = Schema.Struct({
  /** The tool name relative to the router, as `withApprovals` receives it. */
  name: Schema.String,
  /** The HTTP method, such as `GET`. */
  method: Schema.String,
  /** The request path, including any `pathPrefix`. */
  path: Schema.String,
  operationId: Schema.optionalKey(Schema.String),
  /** After `kinds` (keyed by `operationId`, else `name`); otherwise reading methods are queries. */
  kind: Schema.Literals(["query", "mutation"]),
  /** Callable without credentials, so every account and a router without one expose it. */
  public: Schema.Boolean,
  /** The `methods` and `oauth` entries whose accounts expose it. */
  methods: Schema.Array(Schema.String),
});
export type OpenapiToolName = typeof OpenapiToolName.Type;

/** Every tool a definition yields for some account, and the operations the compiler left out. */
export const OpenapiToolNames = Schema.Struct({
  tools: Schema.Array(OpenapiToolName),
  /**
   * Operations the compiler left out, and why. An operation it imports but no configured `methods`
   * or `oauth` entry can authorize is missing from `tools` and is not listed here.
   */
  skipped: Schema.Array(OpenapiSkippedOperation),
});
export type OpenapiToolNames = typeof OpenapiToolNames.Type;
