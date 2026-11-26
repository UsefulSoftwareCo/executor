import type { ProviderError } from "./provider-error.ts";
import type { NetworkRefused } from "./network.ts";
/** GraphQL discovery contracts. Catalogs are evaluated with the selected account. */
import { Schema, type Effect } from "effect";
import { AccountId, HttpUrl, JsonObject, type JsonValue } from "./schema.ts";
import { FailureFieldName, maxUpstreamMessageLength } from "./failure.ts";

/** Provider timeout policy, independent of any enclosing operation deadline. */
export const GraphqlClientLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type GraphqlClientLimits = typeof GraphqlClientLimits.Type;
/** Current GraphQL discovery and call timeout defaults. */
export const defaultGraphqlClientLimits = GraphqlClientLimits.make({
  timeoutMs: 30_000,
  maxTimeoutMs: 300_000,
});

/** Endpoint and credential snapshot for one app evaluation. */
export const GraphqlToolsOptions = Schema.Struct({
  url: HttpUrl,
  accountId: Schema.optional(AccountId),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  signal: Schema.optional(Schema.instanceOf(AbortSignal)),
  timeoutMs: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: defaultGraphqlClientLimits.maxTimeoutMs }),
    ),
  ),
});
export type GraphqlToolsOptions = typeof GraphqlToolsOptions.Type;

/** Most errors of one GraphQL response that a failure carries. */
export const maxGraphqlStatedErrors = 5;
/** Most `extensions` entries carried for one stated error. */
export const maxGraphqlStatedExtensions = 4;
/** Longest path, path segment or `extensions` value carried for one stated error. */
export const maxGraphqlStatedFieldLength = 256;

/**
 * One error a GraphQL server stated in its response's `errors` list, in the format the GraphQL
 * specification documents: its message, the response path it names, and the scalar entries of its
 * `extensions`, such as `code`. Text is bounded where it is read. The path keeps the server's
 * segments, so account secrets are replaced in them before they are written as a path when the
 * failure leaves the app.
 */
export const GraphqlStatedError = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(maxUpstreamMessageLength)),
  /** The first segments of the path, as many as a path of the longest carried length shows. */
  path: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String.check(Schema.isMaxLength(maxGraphqlStatedFieldLength)),
        Schema.Int,
      ]),
    ).check(Schema.isMaxLength(maxGraphqlStatedFieldLength + 1)),
  ),
  extensions: Schema.optional(
    Schema.Record(
      FailureFieldName,
      Schema.Union([
        Schema.String.check(Schema.isMaxLength(maxGraphqlStatedFieldLength)),
        Schema.Finite,
        Schema.Boolean,
      ]),
    ).check(Schema.isMaxProperties(maxGraphqlStatedExtensions)),
  ),
});
export type GraphqlStatedError = typeof GraphqlStatedError.Type;

/**
 * Safe failures omit upstream bodies other than the errors a GraphQL server stated in its
 * documented `errors` list. Execution means a valid GraphQL error response, not malformed data.
 */
export class GraphqlError extends Schema.TaggedError<GraphqlError>()("GraphqlError", {
  phase: Schema.Literals(["discover", "call"]),
  reason: Schema.Literals([
    "request",
    "unauthorized",
    "invalid_response",
    "invalid_input",
    "timeout",
    "execution",
  ]),
  status: Schema.optional(Schema.Number),
  /** The first errors the server stated, in its order. */
  errors: Schema.optional(
    Schema.Array(GraphqlStatedError).check(Schema.isMaxLength(maxGraphqlStatedErrors)),
  ),
  /** How many errors the server stated in all, when it stated more than `errors` carries. */
  stated: Schema.optional(Schema.Int),
  /**
   * Why Executor did not read the JSON body of a refused request: it was larger than error bodies
   * may be, or it did not arrive in time. The status is still the server's answer.
   */
  unreadBody: Schema.optional(Schema.Literals(["too_large", "incomplete"])),
}) {}

const Name = Schema.String.check(Schema.isPattern(/^[_A-Za-z][_0-9A-Za-z]*$/u));
const Kind = Schema.Literals([
  "SCALAR",
  "OBJECT",
  "INTERFACE",
  "UNION",
  "ENUM",
  "INPUT_OBJECT",
  "LIST",
  "NON_NULL",
]);
/** The introspection subset used by tools; unknown upstream fields are omitted. */
export interface GraphqlTypeRef {
  readonly kind:
    | "SCALAR"
    | "OBJECT"
    | "INTERFACE"
    | "UNION"
    | "ENUM"
    | "INPUT_OBJECT"
    | "LIST"
    | "NON_NULL";
  readonly name: string | null;
  readonly ofType?: GraphqlTypeRef | null | undefined;
}
/** Recursive wrappers retain list and nullability information. */
export const GraphqlTypeRef: Schema.Codec<GraphqlTypeRef> = Schema.Struct({
  kind: Kind,
  name: Schema.NullOr(Name),
  ofType: Schema.optional(Schema.NullOr(Schema.suspend(() => GraphqlTypeRef))),
});
const Argument = Schema.Struct({
  name: Name,
  description: Schema.NullOr(Schema.String),
  type: GraphqlTypeRef,
  defaultValue: Schema.NullOr(Schema.String),
});
/** Query/mutation arguments and return type. */
export const GraphqlField = Schema.Struct({
  name: Name,
  description: Schema.NullOr(Schema.String),
  args: Schema.Array(Argument),
  type: GraphqlTypeRef,
});
export type GraphqlField = typeof GraphqlField.Type;
/** Parsed, account-specific remote schema. */
export const GraphqlIntrospection = Schema.Struct({
  __schema: Schema.Struct({
    queryType: Schema.NullOr(Schema.Struct({ name: Name })),
    mutationType: Schema.NullOr(Schema.Struct({ name: Name })),
    types: Schema.Array(
      Schema.Struct({
        kind: Kind,
        name: Name,
        fields: Schema.NullOr(Schema.Array(GraphqlField)),
        inputFields: Schema.NullOr(Schema.Array(Argument)),
        enumValues: Schema.NullOr(Schema.Array(Schema.Struct({ name: Name }))),
      }),
    ),
  }),
});
export type GraphqlIntrospection = typeof GraphqlIntrospection.Type;
/** GraphQL responses keep data separate from protocol errors. */
export const GraphqlResponse = Schema.Struct({
  data: Schema.optional(Schema.NullOr(JsonObject)),
  errors: Schema.optional(Schema.Array(JsonObject)),
});
/** A query or mutation bound to one selected account, with native Effect operations. */
export interface GraphqlTool {
  readonly description: string;
  readonly readOnly: boolean;
  readonly input: Schema.Decoder<JsonValue>;
  readonly run: (
    context: unknown,
    input: JsonValue,
  ) => Effect.Effect<JsonValue, GraphqlError | ProviderError | NetworkRefused>;
}
/** One tool per root field; subscriptions require a separate long-lived host. */
export type GraphqlTools = Readonly<Record<string, GraphqlTool>>;

/** Persisted execution data for one root field; no credentials or executable schema. */
export const GraphqlToolDefinition = Schema.Struct({
  name: Name,
  kind: Schema.Literals(["query", "mutation"]),
  field: Name,
  description: Schema.String,
  arguments: Schema.Array(Schema.Struct({ name: Name, type: Schema.String })),
  inputSchema: JsonObject,
  composite: Schema.Boolean,
  selection: Schema.String,
});
export type GraphqlToolDefinition = typeof GraphqlToolDefinition.Type;
