import { Schema } from "effect";
import { AuthTemplateSlug, type OAuthAuthentication } from "@executor-js/sdk/shared";
import {
  apiKeyMethodFromAuthTemplate,
  isApiKeyAuthTemplate,
  type ApiKeyAuthMethod,
  type ApiKeyAuthTemplate,
} from "@executor-js/sdk/http-auth";

// ---------------------------------------------------------------------------
// Auth-template model.
//
// The apiKey method is the SHARED placements model (`@executor-js/sdk/http-auth`,
// the same shape the graphql/mcp plugins store): N header/query placements,
// each rendered from its own credential input. The oauth template is
// mechanism-intrinsic and comes from core (`OAuthAuthentication`, keyed
// `kind: "oauth2"` with stored endpoints+scopes); an integration's
// `Authentication` union composes the two. Client credentials
// (clientId/secret) live on the core `OAuthClient`, not here.
//
// Pre-canonical stored templates (`type: "apiKey"` with `variable()`-templated
// header/query records) are rewritten by the one-off config migration
// (`migrate-config.ts`) — runtime code knows only this model.
// ---------------------------------------------------------------------------

export { TOKEN_VARIABLE } from "@executor-js/sdk/http-auth";

export type APIKeyAuthentication = ApiKeyAuthMethod;

/** Every method is keyed by `kind` — `kind: "oauth2"` | `kind: "apikey"`. */
export type Authentication = OAuthAuthentication | APIKeyAuthentication;

/** What auth inputs accept: oauth templates (wire-typed: plain slug) plus the
 *  request-shaped apikey dialect (`type: "apiKey"`, headers/queryParams
 *  records) — the ONE apikey authoring shape. Stored configs and the catalog
 *  read as canonical placements; `apiKeyAuthTemplateFromMethod` serializes
 *  them back for read-modify-write flows. */
export type OAuthAuthenticationInput = Omit<OAuthAuthentication, "slug"> & {
  readonly slug: string;
};
export type AuthenticationInput = OAuthAuthenticationInput | ApiKeyAuthTemplate;

/** Expand the request-shaped dialect into canonical placements and brand the
 *  oauth slugs. A dialect entry without a slug gets a blank one —
 *  `mergeAuthTemplates` backfills `custom_<id>`. */
export const normalizeOpenApiAuthInputs = (
  inputs: readonly AuthenticationInput[],
): readonly Authentication[] =>
  inputs.map((input): Authentication => {
    if (!isApiKeyAuthTemplate(input)) {
      return { ...input, slug: AuthTemplateSlug.make(input.slug) };
    }
    const method = apiKeyMethodFromAuthTemplate(input);
    return { ...method, slug: method.slug ?? "" };
  });

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

export const OperationFileHint = Schema.Struct({
  kind: Schema.Literals(["binaryResponse", "byteField"]),
  mimeType: Schema.OptionFromOptional(Schema.String),
  dataField: Schema.OptionFromOptional(Schema.String),
  sizeField: Schema.OptionFromOptional(Schema.String),
  encoding: Schema.OptionFromOptional(Schema.Literals(["base64", "base64url"])),
});
export type OperationFileHint = typeof OperationFileHint.Type;

export const OperationResponseBody = Schema.Struct({
  contentType: Schema.String,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  fileHint: Schema.OptionFromOptional(OperationFileHint),
});
export type OperationResponseBody = typeof OperationResponseBody.Type;

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

export const ExtractedOperation = Schema.Struct({
  operationId: OperationId,
  toolPath: Schema.OptionFromOptional(Schema.String),
  method: HttpMethod,
  servers: Schema.Array(ServerInfo),
  pathTemplate: Schema.String,
  summary: Schema.OptionFromOptional(Schema.String),
  description: Schema.OptionFromOptional(Schema.String),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
  responseBody: Schema.OptionFromOptional(OperationResponseBody),
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  outputSchema: Schema.OptionFromOptional(Schema.Unknown),
  deprecated: Schema.Boolean,
});
export type ExtractedOperation = typeof ExtractedOperation.Type;

export const ExtractionResult = Schema.Struct({
  title: Schema.OptionFromOptional(Schema.String),
  /** The spec's `info.description` — the author's own summary of the API. */
  description: Schema.OptionFromOptional(Schema.String),
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
  servers: Schema.optional(Schema.Array(ServerInfo)),
  pathTemplate: Schema.String,
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
  responseBody: Schema.OptionFromOptional(OperationResponseBody),
});
export type OperationBinding = typeof OperationBinding.Type;

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
