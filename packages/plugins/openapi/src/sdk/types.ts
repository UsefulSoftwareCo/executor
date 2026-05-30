import { Schema } from "effect";
import { ScopedSecretCredentialInput, SecretBackedValue } from "@executor-js/sdk/shared";
import {
  OAuth2Flow as HttpOAuth2Flow,
  OAuth2SourceConfig as SharedOAuth2SourceConfig,
  type OAuth2FlowType,
  type OAuth2SourceConfigType,
} from "@executor-js/sdk/http-source";

export const OAuth2Flow = HttpOAuth2Flow;
export type OAuth2Flow = OAuth2FlowType;
export const OAuth2SourceConfig = SharedOAuth2SourceConfig;
export type OAuth2SourceConfig = OAuth2SourceConfigType;

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const OperationId = Schema.String.pipe(Schema.brand("OperationId"));
export type OperationId = typeof OperationId.Type;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const HttpMethod = Schema.Literals([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);
export type HttpMethod = typeof HttpMethod.Type;

export const ParameterLocation = Schema.Literals(["path", "query", "header", "cookie"]);
export type ParameterLocation = typeof ParameterLocation.Type;

// ---------------------------------------------------------------------------
// Extracted operation
// ---------------------------------------------------------------------------

export const OperationParameter = Schema.Struct({
  name: Schema.String,
  location: ParameterLocation,
  required: Schema.Boolean,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  style: Schema.OptionFromOptional(Schema.String),
  explode: Schema.OptionFromOptional(Schema.Boolean),
  allowReserved: Schema.OptionFromOptional(Schema.Boolean),
  description: Schema.OptionFromOptional(Schema.String),
});
export type OperationParameter = typeof OperationParameter.Type;

/**
 * OpenAPI 3.x `Encoding Object` (§4.8.15). Declared per-property inside a
 * multipart/form-data or application/x-www-form-urlencoded request body.
 *
 * - `contentType` — for multipart, overrides the per-part `Content-Type`
 *   header (e.g. `application/json` for a JSON-encoded metadata part).
 * - `style` / `explode` / `allowReserved` — for form-urlencoded, control
 *   array / object serialization the same way parameter-level style does.
 */
export const EncodingObject = Schema.Struct({
  contentType: Schema.OptionFromOptional(Schema.String),
  style: Schema.OptionFromOptional(Schema.String),
  explode: Schema.OptionFromOptional(Schema.Boolean),
  allowReserved: Schema.OptionFromOptional(Schema.Boolean),
});
export type EncodingObject = typeof EncodingObject.Type;

export const MediaBinding = Schema.Struct({
  contentType: Schema.String,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  encoding: Schema.OptionFromOptional(Schema.Record(Schema.String, EncodingObject)),
});
export type MediaBinding = typeof MediaBinding.Type;

export const OperationRequestBody = Schema.Struct({
  required: Schema.Boolean,
  /** Default media type — first declared in spec order (not JSON-first).
   *  Used when the caller does not override via the tool's `contentType` arg. */
  contentType: Schema.String,
  /** Schema of the default media type. Kept for backward compat with stored
   *  bindings from before `contents` was added. */
  schema: Schema.OptionFromOptional(Schema.Unknown),
  /** All declared media types in spec order. Populated by `extract.ts`
   *  going forward; older persisted bindings may have this unset and will
   *  fall back to `{contentType, schema}`. */
  contents: Schema.OptionFromOptional(Schema.Array(MediaBinding)),
});
export type OperationRequestBody = typeof OperationRequestBody.Type;

export const ExtractedOperation = Schema.Struct({
  operationId: OperationId,
  toolPath: Schema.OptionFromOptional(Schema.String),
  method: HttpMethod,
  baseUrl: Schema.optional(Schema.String),
  pathTemplate: Schema.String,
  summary: Schema.OptionFromOptional(Schema.String),
  description: Schema.OptionFromOptional(Schema.String),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  outputSchema: Schema.OptionFromOptional(Schema.Unknown),
  deprecated: Schema.Boolean,
});
export type ExtractedOperation = typeof ExtractedOperation.Type;

export const ServerVariable = Schema.Struct({
  default: Schema.String,
  enum: Schema.OptionFromOptional(Schema.Array(Schema.String)),
  description: Schema.OptionFromOptional(Schema.String),
});
export type ServerVariable = typeof ServerVariable.Type;

export const ServerInfo = Schema.Struct({
  url: Schema.String,
  description: Schema.OptionFromOptional(Schema.String),
  variables: Schema.OptionFromOptional(Schema.Record(Schema.String, ServerVariable)),
});
export type ServerInfo = typeof ServerInfo.Type;

export const ExtractionResult = Schema.Struct({
  title: Schema.OptionFromOptional(Schema.String),
  version: Schema.OptionFromOptional(Schema.String),
  servers: Schema.Array(ServerInfo),
  operations: Schema.Array(ExtractedOperation),
});
export type ExtractionResult = typeof ExtractionResult.Type;

// ---------------------------------------------------------------------------
// Operation binding — minimal invocation data (no schemas/metadata)
// ---------------------------------------------------------------------------

export const OperationBinding = Schema.Struct({
  method: HttpMethod,
  baseUrl: Schema.optional(Schema.String),
  pathTemplate: Schema.String,
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
});
export type OperationBinding = typeof OperationBinding.Type;

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/**
 * A header value — either a static string or a reference to a secret.
 * Stored as JSON-serializable data.
 */
export const HeaderValue = SecretBackedValue;
export type HeaderValue = typeof HeaderValue.Type;

export const ConfiguredHeaderBinding = Schema.Struct({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: Schema.optional(Schema.String),
}).annotate({ identifier: "OpenApiConfiguredHeaderBinding" });
export type ConfiguredHeaderBinding = typeof ConfiguredHeaderBinding.Type;

export const ConfiguredHeaderValue = Schema.Union([Schema.String, ConfiguredHeaderBinding]);
export type ConfiguredHeaderValue = typeof ConfiguredHeaderValue.Type;

export const OpenApiCredentialInput = Schema.Union([
  ScopedSecretCredentialInput,
  HeaderValue,
  ConfiguredHeaderValue,
]);
export type OpenApiCredentialInput = typeof OpenApiCredentialInput.Type;

// ---------------------------------------------------------------------------
// OAuth2 source config — carries source-owned slots and API-level config to
// kick off a fresh sign-in from the source detail UI without needing any
// one user's live connection to still exist.
//
// Split of responsibilities:
//   - The Source owns: the OAuth config (tokenUrl, authorizationUrl,
//     client credential slots, connection slot, scopes, flow,
//     securitySchemeName).
//     Values are a property of the target API, identical for every user
//     signing into this source. Source-owned = reconnect works even if
//     the connection row has been removed.
//   - The Connection owns: live access/refresh tokens, token expiry,
//     provider state the refresh path reads from. The connection's
//     `providerState` caches the refresh-relevant bits of the config
//     so the refresh loop never reaches back into source storage.
//
// This is a deliberate small duplication (scopes + tokenUrl and the static
// client credential ids referenced by slots appear in source bindings and
// connection providerState). The values are static per source so the two
// copies can't drift under normal reconnect flows.
// ---------------------------------------------------------------------------

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
