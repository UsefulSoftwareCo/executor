import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  ConnectionId,
  CredentialBindingRef,
  InternalError,
  ScopeId,
  SecretBackedValue,
} from "@executor-js/sdk/shared";

import { OpenApiParseError, OpenApiExtractionError, OpenApiOAuthError } from "../sdk/errors";
import { SpecPreview } from "../sdk/preview";
import { StoredSourceSchema } from "../sdk/source-contracts";
import { OAuth2SourceConfig } from "../sdk/types";

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

const OpenApiSpecInputPayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blob"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("googleDiscovery"), url: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("googleDiscoveryBundle"),
    urls: Schema.Array(Schema.String),
  }),
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

const ConfigureCredentialPayload = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: Schema.String,
    secretScope: Schema.optional(ScopeId),
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: ConnectionId,
  }),
]);

const ConfigureCredentialMapPayload = Schema.Record(Schema.String, ConfigureCredentialPayload);

const ConfigurePayload = Schema.Struct({
  source: Schema.Struct({
    id: Schema.String,
    scope: ScopeId,
  }),
  scope: ScopeId,
  headers: Schema.optional(ConfigureCredentialMapPayload),
  queryParams: Schema.optional(ConfigureCredentialMapPayload),
  specFetchCredentials: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(ConfigureCredentialMapPayload),
      queryParams: Schema.optional(ConfigureCredentialMapPayload),
    }),
  ),
  oauth2: Schema.optional(
    Schema.Struct({
      clientId: Schema.optional(ConfigureCredentialPayload),
      clientSecret: Schema.optional(ConfigureCredentialPayload),
      connection: Schema.optional(ConfigureCredentialPayload),
    }),
  ),
  oauth2Source: Schema.optional(OAuth2SourceConfig),
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
    HttpApiEndpoint.post("configure", "/scopes/:scopeId/openapi/configure", {
      params: ScopeIdParam,
      payload: ConfigurePayload,
      success: Schema.Array(CredentialBindingRef),
      error: DomainErrors,
    }),
  );
