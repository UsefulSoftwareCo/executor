import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, ScopeId, SecretBackedValue } from "@executor-js/sdk/shared";

import { OpenApiParseError, OpenApiExtractionError, OpenApiOAuthError } from "../sdk/errors";
import { SpecPreview } from "../sdk/preview";
import { StoredSourceSchema } from "../sdk/source-contracts";
import {
  OAuth2SourceConfig,
  OpenApiSourceBindingInput,
  OpenApiSourceBindingRef,
} from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const DomainErrors = [
  InternalError,
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiOAuthError,
] as const;

const ScopeIdParam = {
  scopeId: ScopeId,
};

const SourceParams = {
  scopeId: ScopeId,
  namespace: Schema.String,
};

const SourceBindingParams = {
  scopeId: ScopeId,
  namespace: Schema.String,
  sourceScopeId: ScopeId,
};

const OpenApiSpecInputPayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blob"), value: Schema.String }),
]);

const PreviewSpecFetchCredentialsPayload = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, SecretBackedValue)),
  queryParams: Schema.optional(Schema.Record(Schema.String, SecretBackedValue)),
});

const OpenApiSecretShapePayload = Schema.Struct({
  kind: Schema.Literal("secret"),
  prefix: Schema.optional(Schema.String),
});

const OpenApiConfiguredValuePayload = Schema.Union([Schema.String, OpenApiSecretShapePayload]);

const SpecFetchCredentialsPayload = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValuePayload)),
  queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValuePayload)),
});

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSpecPayload = Schema.Struct({
  spec: OpenApiSpecInputPayload,
  specFetchCredentials: Schema.optional(SpecFetchCredentialsPayload),
  name: Schema.String,
  baseUrl: Schema.String,
  namespace: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValuePayload)),
  queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValuePayload)),
  oauth2: Schema.optional(OAuth2SourceConfig),
});

const PreviewSpecPayload = Schema.Struct({
  spec: Schema.String,
  specFetchCredentials: Schema.optional(PreviewSpecFetchCredentialsPayload),
});

const UpdateSourcePayload = Schema.Struct({
  sourceScope: ScopeId,
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValuePayload)),
  queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValuePayload)),
  // Set after a successful re-authenticate to refresh the source's
  // stored OAuth2 metadata.
  oauth2: Schema.optional(OAuth2SourceConfig),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

const RemoveBindingPayload = Schema.Struct({
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slot: Schema.String,
  scope: ScopeId,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSpecResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

// HTTP status on the three domain errors lives on their class
// declarations in `../sdk/errors.ts` — see the comment there.

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (OpenApiParseError, OpenApiExtractionError,
// OpenApiOAuthError) are declared once at the group level via
// `.addError(...)` — every endpoint inherits them. The errors themselves
// carry their HTTP status via `HttpApiSchema.annotations` above, so
// handlers just `return yield* ext.foo(...)` and the schema encodes
// whatever comes out.
//
// 5xx is handled at the API level: `.addError(InternalError)` adds the
// shared opaque 500 surface. Defects are captured + downgraded to it by
// an HttpApiBuilder middleware (see apps/cloud/src/observability.ts).
// StorageError → InternalError translation happens at service wiring
// time via `withCapture(executor)`.
// ---------------------------------------------------------------------------

export const OpenApiGroup = HttpApiGroup.make("openapi")
  .add(
    HttpApiEndpoint.post("previewSpec", "/scopes/:scopeId/openapi/preview", {
      params: ScopeIdParam,
      payload: PreviewSpecPayload,
      success: SpecPreview,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("addSpec", "/scopes/:scopeId/openapi/specs", {
      params: ScopeIdParam,
      payload: AddSpecPayload,
      success: AddSpecResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getSource", "/scopes/:scopeId/openapi/sources/:namespace", {
      params: SourceParams,
      success: Schema.NullOr(StoredSourceSchema),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateSource", "/scopes/:scopeId/openapi/sources/:namespace", {
      params: SourceParams,
      payload: UpdateSourcePayload,
      success: UpdateSourceResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listSourceBindings",
      "/scopes/:scopeId/openapi/sources/:namespace/base/:sourceScopeId/bindings",
      {
        params: SourceBindingParams,
        success: Schema.Array(OpenApiSourceBindingRef),
        error: DomainErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("setSourceBinding", "/scopes/:scopeId/openapi/source-bindings", {
      params: ScopeIdParam,
      payload: OpenApiSourceBindingInput,
      success: OpenApiSourceBindingRef,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("removeSourceBinding", "/scopes/:scopeId/openapi/source-bindings/remove", {
      params: ScopeIdParam,
      payload: RemoveBindingPayload,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: DomainErrors,
    }),
  );
