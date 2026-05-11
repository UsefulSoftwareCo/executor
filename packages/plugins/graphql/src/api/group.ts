import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ScopeId } from "@executor-js/sdk/core";
import { InternalError } from "@executor-js/api";

import { GraphqlIntrospectionError, GraphqlExtractionError } from "../sdk/errors";
import {
  ConfiguredGraphqlCredentialValue,
  GraphqlCredentialInput,
  GraphqlSourceAuth,
  GraphqlSourceAuthInput,
  GraphqlSourceBindingInputSchema,
  GraphqlSourceBindingRef,
} from "../sdk/types";

// StoredGraphqlSource shape as an HTTP response schema. Kept local to the
// api layer because the sdk-side `StoredGraphqlSource` is a plain interface.
export const StoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  scope: ScopeId,
  name: Schema.String,
  endpoint: Schema.String,
  headers: Schema.Record(Schema.String, ConfiguredGraphqlCredentialValue),
  queryParams: Schema.Record(Schema.String, ConfiguredGraphqlCredentialValue),
  auth: GraphqlSourceAuth,
});

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = {
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

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSourcePayload = Schema.Struct({
  targetScope: ScopeId,
  endpoint: Schema.String,
  name: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInput)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInput)),
  credentialTargetScope: Schema.optional(ScopeId),
  auth: Schema.optional(GraphqlSourceAuthInput),
});

const UpdateSourcePayload = Schema.Struct({
  sourceScope: ScopeId,
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInput)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInput)),
  credentialTargetScope: Schema.optional(ScopeId),
  auth: Schema.optional(GraphqlSourceAuthInput),
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

const AddSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// Errors with HTTP status
// ---------------------------------------------------------------------------

const IntrospectionError = GraphqlIntrospectionError.annotate({ httpApiStatus: 400 });
const ExtractionError = GraphqlExtractionError.annotate({ httpApiStatus: 400 });

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (GraphqlIntrospectionError etc.) are declared once at
// the group level via `.addError(...)` — every endpoint inherits them. The
// errors themselves carry their HTTP status via `HttpApiSchema.annotations`
// above, so handlers just `return yield* ext.foo(...)` and the schema
// encodes whatever it gets.
//
// 5xx is handled at the API level: `.addError(InternalError)` adds a
// single shared opaque-by-schema 500 surface translated from `StorageError`
// by `withCapture` at the HTTP edge. No per-handler wrapping, no
// per-plugin InternalError.
// ---------------------------------------------------------------------------

const GraphqlErrors = [InternalError, IntrospectionError, ExtractionError] as const;

export const GraphqlGroup = HttpApiGroup.make("graphql")
  .add(
    HttpApiEndpoint.post("addSource", "/scopes/:scopeId/graphql/sources", {
      params: ScopeParams,
      payload: AddSourcePayload,
      success: AddSourceResponse,
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getSource", "/scopes/:scopeId/graphql/sources/:namespace", {
      params: SourceParams,
      success: Schema.NullOr(StoredSourceSchema),
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateSource", "/scopes/:scopeId/graphql/sources/:namespace", {
      params: SourceParams,
      payload: UpdateSourcePayload,
      success: UpdateSourceResponse,
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listSourceBindings",
      "/scopes/:scopeId/graphql/sources/:namespace/base/:sourceScopeId/bindings",
      {
        params: SourceBindingParams,
        success: Schema.Array(GraphqlSourceBindingRef),
        error: GraphqlErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("setSourceBinding", "/scopes/:scopeId/graphql/source-bindings", {
      params: ScopeParams,
      payload: GraphqlSourceBindingInputSchema,
      success: GraphqlSourceBindingRef,
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("removeSourceBinding", "/scopes/:scopeId/graphql/source-bindings/remove", {
      params: ScopeParams,
      payload: RemoveBindingPayload,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: GraphqlErrors,
    }),
  );
// Plugin domain errors carry their own HTTP status (4xx);
// `InternalError` is the shared opaque 500 translated at the HTTP edge.
