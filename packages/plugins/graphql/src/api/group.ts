import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, IntegrationAlreadyExistsError } from "@executor-js/sdk/shared";

import { GraphqlIntrospectionError, GraphqlExtractionError } from "../sdk/errors";
import { GraphqlAuthMethod, GraphqlAuthMethodInput } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const IntegrationParams = {
  slug: Schema.String,
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddIntegrationPayload = Schema.Struct({
  endpoint: Schema.String,
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(GraphqlAuthMethodInput)),
});

// The `configure` payload — the custom auth methods to merge-append onto the
// integration's `authenticationTemplate`. Reuses the same input schema as
// `addIntegration` (slug optional — the backend backfills it) so a custom
// apikey method round-trips identically.
const ConfigurePayload = Schema.Struct({
  authenticationTemplate: Schema.Array(GraphqlAuthMethodInput),
  mode: Schema.optional(Schema.Literals(["merge", "replace"])),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddIntegrationResponse = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
});

// The integration config surfaced for the configure UX. Carries the
// `authenticationTemplate` the configure / custom-method flow reads/writes.
// The introspection snapshot is deliberately NOT served: it's a multi-MB
// build artifact in the plugin blob store, and no client reads it.
const GraphqlConfigView = Schema.Struct({
  endpoint: Schema.String,
  name: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.Array(GraphqlAuthMethod),
});

// The configure result — the merged `authenticationTemplate` after the new
// custom methods were appended/replaced.
const ConfigureResponse = Schema.Struct({
  authenticationTemplate: Schema.Array(GraphqlAuthMethod),
});

// ---------------------------------------------------------------------------
// Errors with HTTP status
// ---------------------------------------------------------------------------

const IntrospectionError = GraphqlIntrospectionError.annotate({
  httpApiStatus: 400,
});
const ExtractionError = GraphqlExtractionError.annotate({ httpApiStatus: 400 });

// ---------------------------------------------------------------------------
// Group — the GraphQL HTTP surface over integrations.
//
// Plugin SDK errors (GraphqlIntrospectionError etc.) are declared once at the
// group level via `.addError(...)`. `InternalError` is the shared opaque-by-
// schema 500 surface translated from `StorageError` by `withCapture` at the
// HTTP edge.
// ---------------------------------------------------------------------------

const GraphqlErrors = [
  InternalError,
  IntrospectionError,
  ExtractionError,
  IntegrationAlreadyExistsError,
] as const;

export const GraphqlGroup = HttpApiGroup.make("graphql")
  .add(
    HttpApiEndpoint.post("addIntegration", "/graphql/integrations", {
      payload: AddIntegrationPayload,
      success: AddIntegrationResponse,
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getIntegration", "/graphql/integrations/:slug", {
      params: IntegrationParams,
      success: Schema.NullOr(Schema.Unknown),
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConfig", "/graphql/integrations/:slug/config", {
      params: IntegrationParams,
      success: Schema.NullOr(GraphqlConfigView),
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("configure", "/graphql/integrations/:slug/config", {
      params: IntegrationParams,
      payload: ConfigurePayload,
      success: ConfigureResponse,
      error: GraphqlErrors,
    }),
  );
