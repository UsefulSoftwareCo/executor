import type { ProviderError } from "./provider-error.ts";
/** Credential-free OpenAPI request declarations and validation schemas retained with app source. */
import { Schema, type Effect } from "effect";
import { AccountId, HttpUrl, JsonObject } from "./schema.ts";
import { ApiErrorResponse, type OpenapiResponseError } from "./api-response-error.ts";

/** Tagged error shapes retain an explicit source for their public message. */
export const OpenapiErrorResponse = Schema.Struct({
  code: ApiErrorResponse.fields.code,
  status: ApiErrorResponse.fields.status,
  message: Schema.Union([
    Schema.Struct({ source: Schema.Literal("body") }),
    Schema.Struct({ source: Schema.Literal("schema"), value: ApiErrorResponse.fields.message }),
  ]),
  schema: JsonObject,
});
/** A retained declaration used to validate an HTTP failure before exposing its code. */
export type OpenapiErrorResponse = typeof OpenapiErrorResponse.Type;

/** Resolved OpenAPI parameter shared by import validation and request construction. */
export const OpenapiParameter = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header", "cookie"]),
  required: Schema.optionalKey(Schema.Boolean),
  schema: Schema.optionalKey(JsonObject),
  style: Schema.optionalKey(Schema.String),
  explode: Schema.optionalKey(Schema.Boolean),
  allowReserved: Schema.optionalKey(Schema.Boolean),
  allowEmptyValue: Schema.optionalKey(Schema.Boolean),
  content: Schema.optionalKey(JsonObject),
});
export type OpenapiParameter = typeof OpenapiParameter.Type;
/** Preserve media schemas and Encoding Objects for Swagger request construction. */
export const OpenapiRequestBody = Schema.Struct({
  required: Schema.optionalKey(Schema.Boolean),
  content: Schema.Record(
    Schema.String,
    Schema.Struct({
      schema: Schema.optionalKey(JsonObject),
      encoding: Schema.optionalKey(JsonObject),
    }),
  ),
});

/** Credential-free operation data emitted by the OpenAPI importer. */
export const OpenapiOperation = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: Schema.String,
  baseUrl: HttpUrl,
  openapi: Schema.String,
  securitySchemes: Schema.Record(Schema.String, JsonObject),
  /** The resolved OpenAPI Operation Object; Executor schemas remain separate. */
  request: Schema.Struct({
    parameters: Schema.Array(OpenapiParameter),
    requestBody: Schema.optionalKey(OpenapiRequestBody),
    security: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    responses: Schema.Record(Schema.String, JsonObject),
  }),
  /** Streams remain in the metadata but cannot run through a single-result tool call. */
  streaming: Schema.optionalKey(Schema.Literal(true)),
  input: JsonObject,
  outputSchema: Schema.optionalKey(JsonObject),
  errorResponses: Schema.optionalKey(Schema.Array(OpenapiErrorResponse)),
});
export type OpenapiOperation = typeof OpenapiOperation.Type;

/** Map a selected account field to one Swagger credential value. */
export const CredentialBinding = Schema.Struct({
  scheme: Schema.String,
  field: Schema.String,
  part: Schema.Literals(["value", "username", "password"]),
  prefix: Schema.String,
});
export type CredentialBinding = typeof CredentialBinding.Type;

/** Selected credentials stay in the server runtime, separate from operation metadata. */
export const OpenapiAccount = Schema.Struct({
  id: Schema.optional(AccountId),
  method: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});
export type OpenapiAccount = typeof OpenapiAccount.Type;

/**
 * Parameter values bound by the selected account, grouped as in tool input. Callers may omit
 * these parameters; an explicit value still takes precedence and the API still authorizes it.
 */
export const OpenapiParameterDefaults = Schema.Struct({
  path: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type OpenapiParameterDefaults = typeof OpenapiParameterDefaults.Type;

/** Parsed options for one account's evaluation. */
export const OpenapiToolsOptions = Schema.Struct({
  operations: Schema.Array(OpenapiOperation),
  /**
   * Component schemas stored once per app and referenced as `#/$defs/<name>`. Operations
   * generated before shared definitions carry their own `$defs` and omit this.
   */
  definitions: Schema.optional(Schema.Record(Schema.String, JsonObject)),
  methods: Schema.Record(Schema.String, Schema.Array(CredentialBinding)),
  oauth: Schema.Array(Schema.String),
  account: Schema.optional(OpenapiAccount),
  parameterDefaults: Schema.optional(OpenapiParameterDefaults),
  signal: Schema.optional(Schema.instanceOf(AbortSignal)),
  fetch: Schema.optional(
    Schema.declare((value): value is typeof globalThis.fetch => typeof value === "function"),
  ),
});
/** JSON imports are decoded at the helper boundary, without assertions in app source. */
export type OpenapiToolsOptions = Omit<
  typeof OpenapiToolsOptions.Type,
  "operations" | "definitions"
> & {
  readonly operations: unknown;
  readonly definitions?: unknown;
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
  readonly run: (
    context: unknown,
    input: Schema.Json,
  ) => Effect.Effect<unknown, OpenapiError | OpenapiResponseError | ProviderError>;
}
/** Executable operations keyed by their generated names. */
export type OpenapiTools = Readonly<Record<string, OpenapiTool>>;

/** Tool calls buffer one bounded result; live event streams require an authored subscription. */
export const defaultOpenapiResponseLimits = {
  maxBodyBytes: 16_777_216,
  readTimeoutMs: 30_000,
} as const;
/** Media returned as text rather than a base64 file. NDJSON remains an unparsed text result. */
export const isOpenapiTextMedia = (type: string): boolean =>
  /^(?:text\/|application\/(?:[\w.-]+\+)?(?:json|xml)|application\/(?:javascript|x-ndjson|x-www-form-urlencoded))/i.test(
    type,
  );
/** A form field that carries raw file bytes: OpenAPI 3.1 `contentMediaType` without an
 * encoding, or the `format: binary` string that 3.1 documents still commonly use. */
export const isOpenapiFileSchema = (shape: Readonly<Record<string, unknown>>): boolean =>
  (shape.contentMediaType !== undefined && shape.contentEncoding === undefined) ||
  (shape.type === "string" && shape.format === "binary");
/** JSON-safe binary result, independent of the host's file storage. */
export const openapiBinaryResultSchema: JsonObject = {
  type: "object",
  properties: {
    base64: { type: "string", contentEncoding: "base64" },
    contentType: { type: "string" },
  },
  required: ["base64", "contentType"],
  additionalProperties: false,
};

/** Classify request media for JSON-safe tool arguments; Swagger owns wire serialization. */
export const openapiMediaKind = (type: string) =>
  type.includes("json") && !type.includes("ndjson")
    ? "json"
    : type === "application/x-www-form-urlencoded"
      ? "form"
      : type === "multipart/form-data"
        ? "multipart"
        : isOpenapiTextMedia(type)
          ? "text"
          : "binary";
