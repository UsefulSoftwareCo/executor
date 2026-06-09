import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  InternalError,
  IntegrationAlreadyExistsError,
  IntegrationSlug,
} from "@executor-js/sdk/shared";

import { OpenApiParseError, OpenApiExtractionError, OpenApiOAuthError } from "../sdk/errors";
import { SpecPreview } from "../sdk/preview";

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

const SlugParams = {
  slug: Schema.String,
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const OpenApiSpecInputPayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blob"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("googleDiscovery"),
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("googleDiscoveryBundle"),
    urls: Schema.Array(Schema.String),
  }),
]);

const AuthenticationVariablePayload = Schema.Struct({
  type: Schema.Literal("variable"),
  name: Schema.String,
});
const AuthenticationTemplateValuePayload = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([Schema.String, AuthenticationVariablePayload])),
]);
const AuthenticationPayload = Schema.Union([
  Schema.Struct({
    slug: Schema.String,
    type: Schema.Literal("apiKey"),
    headers: Schema.optional(Schema.Record(Schema.String, AuthenticationTemplateValuePayload)),
    queryParams: Schema.optional(Schema.Record(Schema.String, AuthenticationTemplateValuePayload)),
  }),
  Schema.Struct({
    slug: Schema.String,
    type: Schema.Literal("oauth"),
    authorizationUrl: Schema.String,
    tokenUrl: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
]);

const AddSpecPayload = Schema.Struct({
  spec: OpenApiSpecInputPayload,
  slug: Schema.String,
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

const IntegrationView = Schema.Struct({
  slug: IntegrationSlug,
  description: Schema.String,
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
});

// The full opaque integration config, surfaced for the configure UX. Unlike
// `IntegrationView` (catalog identity only), this carries the
// `authenticationTemplate` the configure flow reads/writes.
const OpenApiConfigView = Schema.Struct({
  spec: Schema.String,
  sourceUrl: Schema.optional(Schema.String),
  googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationPayload)),
});

// The configure result — the merged `authenticationTemplate` after the new
// custom methods were appended/replaced.
const ConfigureResponse = Schema.Struct({
  authenticationTemplate: Schema.Array(AuthenticationPayload),
});

// ---------------------------------------------------------------------------
// Group — addSpec/preview/get/remove over the integration catalog.
// ---------------------------------------------------------------------------

export const OpenApiGroup = HttpApiGroup.make("openapi")
  .add(
    HttpApiEndpoint.post("previewSpec", "/openapi/preview", {
      payload: PreviewSpecPayload,
      success: SpecPreview,
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
    HttpApiEndpoint.delete("removeSpec", "/openapi/integrations/:slug", {
      params: SlugParams,
      success: Schema.Void,
      error: DomainErrors,
    }),
  );
