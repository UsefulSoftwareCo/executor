// ---------------------------------------------------------------------------
// Integrations HTTP API — the v2 catalog surface (was `sources`).
//
// An integration is the tenant-shared catalog identity (slug + description +
// which plugin owns it). The executor is bound to its `{ tenant, subject }` from
// the request auth, so integration routes carry no scope segment — the catalog
// is tenant-level. Connections (owner-scoped credentials) live in their own
// group; credential-binding endpoints are gone (folded into connections).
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  IntegrationDetectionResult,
  IntegrationNotFoundError,
  IntegrationRemovalNotAllowedError,
  IntegrationSlug,
  InternalError,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const IntegrationParams = { slug: IntegrationSlug };

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

/** Where a credential value is carried — mirrors the SDK's
 *  `AuthPlacementDescriptor`. */
const PlacementDescriptor = Schema.Struct({
  carrier: Schema.Literals(["header", "query"]),
  name: Schema.String,
  prefix: Schema.String,
});

/** OAuth specifics — mirrors the SDK's `AuthMethodOAuthDescriptor`. */
const OAuthDescriptor = Schema.Struct({
  discoveryUrl: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  registrationEndpoint: Schema.optional(Schema.String),
  supportsDynamicRegistration: Schema.optional(Schema.Boolean),
});

/** A single declared auth method — mirrors the SDK's `AuthMethodDescriptor`. */
const AuthMethodDescriptorSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["oauth", "apikey", "header", "none"]),
  template: Schema.String,
  placements: Schema.optional(Schema.Array(PlacementDescriptor)),
  oauth: Schema.optional(OAuthDescriptor),
});

/** Public projection of an integration — mirrors the SDK's `Integration`. */
const IntegrationResponse = Schema.Struct({
  slug: IntegrationSlug,
  description: Schema.String,
  /** The plugin that owns this integration kind (e.g. "openapi", "mcp"). */
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
  /** Declared auth methods derived from the owning plugin's stored config.
   *  Always present (possibly empty) so the client never handles absence. */
  authMethods: Schema.Array(AuthMethodDescriptorSchema),
  /** Non-secret URL derived from opaque integration config for favicons. */
  displayUrl: Schema.optional(Schema.String),
});

const UpdateIntegrationPayload = Schema.Struct({
  description: Schema.optional(Schema.String),
});

const DetectRequest = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_048)),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const IntegrationNotFound = IntegrationNotFoundError.annotate({ httpApiStatus: 404 });
const IntegrationRemovalNotAllowed = IntegrationRemovalNotAllowedError.annotate({
  httpApiStatus: 409,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const IntegrationsApi = HttpApiGroup.make("integrations")
  .add(
    HttpApiEndpoint.get("list", "/integrations", {
      success: Schema.Array(IntegrationResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/integrations/:slug", {
      params: IntegrationParams,
      success: IntegrationResponse,
      error: [InternalError, IntegrationNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/integrations/:slug", {
      params: IntegrationParams,
      payload: UpdateIntegrationPayload,
      success: IntegrationResponse,
      error: [InternalError, IntegrationNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/integrations/:slug", {
      params: IntegrationParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, IntegrationRemovalNotAllowed],
    }),
  )
  .add(
    HttpApiEndpoint.post("detect", "/integrations/detect", {
      payload: DetectRequest,
      success: Schema.Array(IntegrationDetectionResult),
      error: InternalError,
    }),
  );
