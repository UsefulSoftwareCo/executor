/** OpenAPI boundary parsing. Unsupported transport/auth features fail before deployment. */
import { Schema } from "effect";
import { JsonObject } from "@executor-js/sdk";

const Server = Schema.Struct({ url: Schema.String, variables: Schema.optional(JsonObject) });
/** Parsed OpenAPI 3 source; individual operation references are resolved separately. */
export const Specification = Schema.Struct({
  openapi: Schema.String,
  servers: Schema.optional(Schema.Array(Server)),
  paths: Schema.Record(Schema.String, JsonObject),
  components: Schema.optional(
    Schema.Struct({
      schemas: Schema.optional(Schema.Record(Schema.String, JsonObject)),
      securitySchemes: Schema.optional(Schema.Record(Schema.String, JsonObject)),
    }),
  ),
  security: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
});
export type Specification = typeof Specification.Type;
/** Parameter schema kept separately from its HTTP placement. */
export const Parameter = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header", "cookie"]),
  required: Schema.optional(Schema.Boolean),
  schema: Schema.optional(JsonObject),
  style: Schema.optional(Schema.String),
  explode: Schema.optional(Schema.Boolean),
  allowReserved: Schema.optional(Schema.Boolean),
  content: Schema.optional(JsonObject),
});
export type Parameter = typeof Parameter.Type;
/** JSON bodies and binary file bodies are the currently executable media types. */
export const RequestBody = Schema.Struct({
  required: Schema.optional(Schema.Boolean),
  content: Schema.Record(Schema.String, Schema.Struct({ schema: Schema.optional(JsonObject) })),
});
/** Operation transport details. We never interpolate upstream executable code. */
export const Operation = Schema.Struct({
  operationId: Schema.optional(Schema.String),
  responses: Schema.optional(Schema.Record(Schema.String, JsonObject)),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Array(JsonObject)),
  requestBody: Schema.optional(JsonObject),
  security: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
  servers: Schema.optional(Schema.Array(Server)),
});
export type Operation = typeof Operation.Type;
import type { CredentialBinding } from "apps/openapi";
export type {
  RequestParameter,
  OpenapiOperation as GeneratedOperation,
  CredentialBinding,
} from "apps/openapi";
/** A secrets method can satisfy an AND-set of OpenAPI security schemes. */
export interface GeneratedSecrets {
  readonly name: string;
  readonly label: string;
  readonly bindings: readonly CredentialBinding[];
}

/** Import hints after product catalog overrides have been applied. */
export interface OpenApiImport {
  readonly name: string;
  readonly connectUrl?: string | undefined;
  /** Prefer protected-resource discovery when the API supports dynamic OAuth client registration. */
  readonly oauthDiscoveryUrl?: string | undefined;
  readonly auth?: { readonly kind: string; readonly header?: string | undefined } | undefined;
  readonly scopes?: readonly string[] | undefined;
}
