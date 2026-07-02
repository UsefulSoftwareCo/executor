import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ApiKeyAuthMethod, ApiKeyAuthTemplate } from "@executor-js/sdk/http-auth";
import {
  InternalError,
  IntegrationAlreadyExistsError,
  IntegrationNotFoundError,
  IntegrationSlug,
} from "@executor-js/sdk/shared";

import { OpenApiParseError, OpenApiExtractionError, OpenApiOAuthError } from "../sdk/errors";
import { SpecPreviewSummary } from "../sdk/preview";

// ---------------------------------------------------------------------------
// Errors — the plugin-domain tagged errors flow directly to clients
// (4xx, each carrying its own `httpApiStatus`). `InternalError` is the shared
// opaque 500 surface; `StorageError` → `InternalError` translation happens at
// service wiring time. `IntegrationAlreadyExistsError` (409) blocks re-adding
// an existing slug — see addSpec.
// ---------------------------------------------------------------------------

const DomainErrors = [
  InternalError,
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiOAuthError,
  IntegrationAlreadyExistsError,
] as const;

const IntegrationNotFound = IntegrationNotFoundError.annotate({ httpApiStatus: 404 });

const UpdateSpecErrors = [
  InternalError,
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiOAuthError,
  IntegrationNotFound,
] as const;

const SlugParams = {
  slug: Schema.String,
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const OpenApiSpecInputPayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blob"), value: Schema.String }),
]);

const OAuthTemplatePayload = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.Array(Schema.String),
  supportsClientIdMetadataDocument: Schema.optional(Schema.Boolean),
});

/** Auth INPUTS: oauth templates + the request-shaped apikey dialect. */
const AuthenticationPayload = Schema.Union([OAuthTemplatePayload, ApiKeyAuthTemplate]);

/** Auth in RESPONSES: the canonical stored shapes (placements). */
const AuthenticationResponse = Schema.Union([OAuthTemplatePayload, ApiKeyAuthMethod]);

const AddSpecPayload = Schema.Struct({
  spec: OpenApiSpecInputPayload,
  slug: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationPayload)),
});

const PreviewSpecPayload = Schema.Struct({
  spec: Schema.String,
});

// The `configure` payload — the new/updated auth methods to merge onto the
// integration's `authenticationTemplate`. Reuses the same `AuthenticationPayload`
// schema as `addSpec` so a custom apiKey method round-trips identically.
const ConfigurePayload = Schema.Struct({
  authenticationTemplate: Schema.Array(AuthenticationPayload),
  mode: Schema.optional(Schema.Literals(["merge", "replace"])),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSpecResponse = Schema.Struct({
  slug: IntegrationSlug,
  toolCount: Schema.Number,
});

// Update the spec in place. Body optional fields only: an empty payload means
// "re-fetch from the stored source URL".
const UpdateSpecPayload = Schema.Struct({
  spec: Schema.optional(OpenApiSpecInputPayload),
});

const UpdateSpecResponse = Schema.Struct({
  slug: IntegrationSlug,
  toolCount: Schema.Number,
  /** Tool names new in this spec version (same diff for every connection). */
  addedTools: Schema.Array(Schema.String),
  /** Tool names the new spec no longer defines. */
  removedTools: Schema.Array(Schema.String),
});

const IntegrationView = Schema.Struct({
  slug: IntegrationSlug,
  description: Schema.String,
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
});

// The integration config surfaced for the configure UX. Unlike
// `IntegrationView` (catalog identity only), this carries the
// `authenticationTemplate` the configure flow reads/writes. The spec text is
// deliberately NOT served: it's a multi-MB build artifact in the plugin blob
// store, and no client reads it (the configure UI only touches the template).
const OpenApiConfigView = Schema.Struct({
  sourceUrl: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationResponse)),
});

// The configure result — the merged `authenticationTemplate` after the new
// custom methods were appended/replaced.
const ConfigureResponse = Schema.Struct({
  authenticationTemplate: Schema.Array(AuthenticationResponse),
});

// ---------------------------------------------------------------------------
// Group — addSpec/preview/get/remove over the integration catalog.
// ---------------------------------------------------------------------------

export const OpenApiGroup = HttpApiGroup.make("openapi")
  .add(
    HttpApiEndpoint.post("previewSpec", "/openapi/preview", {
      payload: PreviewSpecPayload,
      success: SpecPreviewSummary,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("addSpec", "/openapi/specs", {
      payload: AddSpecPayload,
      success: AddSpecResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getIntegration", "/openapi/integrations/:slug", {
      params: SlugParams,
      success: Schema.NullOr(IntegrationView),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConfig", "/openapi/integrations/:slug/config", {
      params: SlugParams,
      success: Schema.NullOr(OpenApiConfigView),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("configure", "/openapi/integrations/:slug/config", {
      params: SlugParams,
      payload: ConfigurePayload,
      success: ConfigureResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateSpec", "/openapi/integrations/:slug/spec", {
      params: SlugParams,
      payload: UpdateSpecPayload,
      success: UpdateSpecResponse,
      error: UpdateSpecErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeSpec", "/openapi/integrations/:slug", {
      params: SlugParams,
      success: Schema.Void,
      error: DomainErrors,
    }),
  );
