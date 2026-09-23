import type { ProviderError } from "./provider-error.ts";
/** GraphQL discovery contracts. Catalogs are evaluated with the selected account. */
import { Schema, type Effect } from "effect";
import { AccountId, HttpUrl, JsonObject, type JsonValue } from "./schema.ts";

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

/** Safe failures omit upstream bodies. Execution means a valid GraphQL error response, not malformed data. */
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
}) {}

const Name = Schema.String.check(Schema.isPattern(/^[_A-Za-z][_0-9A-Za-z]*$/));
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
  ) => Effect.Effect<JsonValue, GraphqlError | ProviderError>;
}
/** One tool per root field; subscriptions require a separate long-lived host. */
export type GraphqlTools = Readonly<Record<string, GraphqlTool>>;
