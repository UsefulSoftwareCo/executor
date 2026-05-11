import { Schema } from "effect";
import {
  ConnectionId,
  ScopeId,
  ScopedSecretCredentialInput,
  SecretBackedValue,
  SecretId,
} from "@executor-js/sdk/core";

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

export class OperationParameter extends Schema.Class<OperationParameter>("OperationParameter")({
  name: Schema.String,
  location: ParameterLocation,
  required: Schema.Boolean,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  style: Schema.OptionFromOptional(Schema.String),
  explode: Schema.OptionFromOptional(Schema.Boolean),
  allowReserved: Schema.OptionFromOptional(Schema.Boolean),
  description: Schema.OptionFromOptional(Schema.String),
}) {}

/**
 * OpenAPI 3.x `Encoding Object` (§4.8.15). Declared per-property inside a
 * multipart/form-data or application/x-www-form-urlencoded request body.
 *
 * - `contentType` — for multipart, overrides the per-part `Content-Type`
 *   header (e.g. `application/json` for a JSON-encoded metadata part).
 * - `style` / `explode` / `allowReserved` — for form-urlencoded, control
 *   array / object serialization the same way parameter-level style does.
 */
export class EncodingObject extends Schema.Class<EncodingObject>("EncodingObject")({
  contentType: Schema.OptionFromOptional(Schema.String),
  style: Schema.OptionFromOptional(Schema.String),
  explode: Schema.OptionFromOptional(Schema.Boolean),
  allowReserved: Schema.OptionFromOptional(Schema.Boolean),
}) {}

export class MediaBinding extends Schema.Class<MediaBinding>("MediaBinding")({
  contentType: Schema.String,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  encoding: Schema.OptionFromOptional(Schema.Record(Schema.String, EncodingObject)),
}) {}

export class OperationRequestBody extends Schema.Class<OperationRequestBody>(
  "OperationRequestBody",
)({
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
}) {}

export class ExtractedOperation extends Schema.Class<ExtractedOperation>("ExtractedOperation")({
  operationId: OperationId,
  method: HttpMethod,
  pathTemplate: Schema.String,
  summary: Schema.OptionFromOptional(Schema.String),
  description: Schema.OptionFromOptional(Schema.String),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  outputSchema: Schema.OptionFromOptional(Schema.Unknown),
  deprecated: Schema.Boolean,
}) {}

export class ServerVariable extends Schema.Class<ServerVariable>("ServerVariable")({
  default: Schema.String,
  enum: Schema.OptionFromOptional(Schema.Array(Schema.String)),
  description: Schema.OptionFromOptional(Schema.String),
}) {}

export class ServerInfo extends Schema.Class<ServerInfo>("ServerInfo")({
  url: Schema.String,
  description: Schema.OptionFromOptional(Schema.String),
  variables: Schema.OptionFromOptional(Schema.Record(Schema.String, ServerVariable)),
}) {}

export class ExtractionResult extends Schema.Class<ExtractionResult>("ExtractionResult")({
  title: Schema.OptionFromOptional(Schema.String),
  version: Schema.OptionFromOptional(Schema.String),
  servers: Schema.Array(ServerInfo),
  operations: Schema.Array(ExtractedOperation),
}) {}

// ---------------------------------------------------------------------------
// Operation binding — minimal invocation data (no schemas/metadata)
// ---------------------------------------------------------------------------

export class OperationBinding extends Schema.Class<OperationBinding>("OperationBinding")({
  method: HttpMethod,
  pathTemplate: Schema.String,
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
}) {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/**
 * A header value — either a static string or a reference to a secret.
 * Stored as JSON-serializable data.
 */
export const HeaderValue = SecretBackedValue;
export type HeaderValue = typeof HeaderValue.Type;

export class ConfiguredHeaderBinding extends Schema.Class<ConfiguredHeaderBinding>(
  "OpenApiConfiguredHeaderBinding",
)({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: Schema.optional(Schema.String),
}) {}

export const ConfiguredHeaderValue = Schema.Union([Schema.String, ConfiguredHeaderBinding]);
export type ConfiguredHeaderValue = typeof ConfiguredHeaderValue.Type;

export const OpenApiCredentialInput = Schema.Union([
  ScopedSecretCredentialInput,
  HeaderValue,
  ConfiguredHeaderValue,
]);
export type OpenApiCredentialInput = typeof OpenApiCredentialInput.Type;

export const OpenApiSourceBindingValue = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: SecretId,
    secretScopeId: Schema.optional(ScopeId),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: ConnectionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
  }),
]);
export type OpenApiSourceBindingValue = typeof OpenApiSourceBindingValue.Type;

export const OpenApiSourceBindingInputSchema = Schema.Struct({
  sourceId: Schema.String,
  sourceScope: ScopeId,
  scope: ScopeId,
  slot: Schema.String,
  value: OpenApiSourceBindingValue,
});

export class OpenApiSourceBindingInput extends Schema.Class<OpenApiSourceBindingInput>(
  "OpenApiSourceBindingInput",
)(OpenApiSourceBindingInputSchema.fields) {}

export class OpenApiSourceBindingRef extends Schema.Class<OpenApiSourceBindingRef>(
  "OpenApiSourceBindingRef",
)({
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  scopeId: ScopeId,
  slot: Schema.String,
  value: OpenApiSourceBindingValue,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

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

export const OAuth2Flow = Schema.Literals(["authorizationCode", "clientCredentials"]);
export type OAuth2Flow = typeof OAuth2Flow.Type;

export const OAuth2SourceConfigSchema = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String),
  issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export class OAuth2SourceConfig extends Schema.Class<OAuth2SourceConfig>(
  "OpenApiOAuth2SourceConfig",
)(OAuth2SourceConfigSchema.fields) {}

export class InvocationResult extends Schema.Class<InvocationResult>("InvocationResult")({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
}) {}
