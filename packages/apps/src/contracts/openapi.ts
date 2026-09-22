/** Normalized OpenAPI metadata retained with app source; no compiler or protocol client is required. */
import { Schema, type Effect } from "effect";
import { HttpUrl, JsonObject } from "./schema.ts";

/** One parameter's HTTP placement and serialization. */
export const RequestParameter = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header"]),
  style: Schema.String,
  explode: Schema.Boolean,
});
export type RequestParameter = typeof RequestParameter.Type;

/** Credential-free operation data emitted by the OpenAPI importer. */
export const OpenapiOperation = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: Schema.String,
  baseUrl: HttpUrl,
  parameters: Schema.Array(RequestParameter),
  body: Schema.Literals(["json", "base64", "none"]),
  /** Streams remain in the metadata but cannot run through a single-result tool call. */
  streaming: Schema.optionalKey(Schema.Literal(true)),
  security: Schema.Array(Schema.Array(Schema.String)),
  input: JsonObject,
  outputSchema: Schema.optionalKey(JsonObject),
});
export type OpenapiOperation = typeof OpenapiOperation.Type;

/** One field's placement, potentially combined with other fields in an authentication method. */
export const CredentialBinding = Schema.Struct({
  scheme: Schema.String,
  field: Schema.String,
  in: Schema.Literals(["header", "query"]),
  name: Schema.String,
  prefix: Schema.String,
});
export type CredentialBinding = typeof CredentialBinding.Type;

/** Selected credentials stay in the server runtime, separate from operation metadata. */
export const OpenapiAccount = Schema.Struct({
  method: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});
export type OpenapiAccount = typeof OpenapiAccount.Type;

/** Parsed options for one account's evaluation. */
export const OpenapiToolsOptions = Schema.Struct({
  operations: Schema.Array(OpenapiOperation),
  methods: Schema.Record(Schema.String, Schema.Array(CredentialBinding)),
  oauth: Schema.Array(Schema.String),
  account: Schema.optional(OpenapiAccount),
  signal: Schema.optional(Schema.instanceOf(AbortSignal)),
  fetch: Schema.optional(
    Schema.declare((value): value is typeof globalThis.fetch => typeof value === "function"),
  ),
});
/** JSON imports are decoded at the helper boundary, without assertions in app source. */
export type OpenapiToolsOptions = Omit<typeof OpenapiToolsOptions.Type, "operations"> & {
  readonly operations: unknown;
};

/** Safe failures omit request headers, credentials and upstream bodies. */
export class OpenapiError extends Schema.TaggedError<OpenapiError>()("OpenapiError", {
  reason: Schema.Literals(["invalid_definition", "invalid_input", "request"]),
  status: Schema.optional(Schema.Number),
}) {}

/** An ordinary native tool bound to one selected account. */
export interface OpenapiTool {
  readonly description: string;
  readonly readOnly: boolean;
  readonly outputSchema?: JsonObject;
  readonly input: Schema.Decoder<Schema.Json>;
  readonly run: (context: unknown, input: Schema.Json) => Effect.Effect<unknown, OpenapiError>;
}
/** Executable operations keyed by their generated names. */
export type OpenapiTools = Readonly<Record<string, OpenapiTool>>;
