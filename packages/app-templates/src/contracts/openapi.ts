/** OpenAPI boundary parsing. Unsupported transport/auth features fail before deployment. */
import { Schema } from "effect";
import { JsonObject } from "@executor-js/sdk";

const Server = Schema.Struct({ url: Schema.String, variables: Schema.optionalKey(JsonObject) });
/** Parsed OpenAPI 3 source; individual operation references are resolved separately. */
export const Specification = Schema.Struct({
  openapi: Schema.String,
  servers: Schema.optionalKey(Schema.Array(Server)),
  paths: Schema.Record(Schema.String, JsonObject),
  components: Schema.optionalKey(
    Schema.Struct({
      schemas: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
      securitySchemes: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
    }),
  ),
  security: Schema.optionalKey(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
});
export type Specification = typeof Specification.Type;
export { OpenapiParameter as Parameter, OpenapiRequestBody as RequestBody } from "apps/openapi";
/** Operation transport details. We never interpolate upstream executable code. */
export const Operation = Schema.Struct({
  operationId: Schema.optionalKey(Schema.String),
  responses: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Array(JsonObject)),
  requestBody: Schema.optionalKey(JsonObject),
  security: Schema.optionalKey(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
  servers: Schema.optionalKey(Schema.Array(Server)),
});
export type Operation = typeof Operation.Type;
import type { CredentialBinding } from "apps/openapi";
export type { OpenapiOperation as GeneratedOperation, CredentialBinding } from "apps/openapi";
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
