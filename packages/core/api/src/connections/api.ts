// ---------------------------------------------------------------------------
// Connections HTTP API — the v2 credential surface.
//
// A connection IS the credential: owner-scoped (org | user), bound 1:1 to an
// integration, resolving its value through a `CredentialProvider`. Identified by
// `(owner, integration, name)`. No scope segments, no token-secret-ids, no
// identity-override-by-scope — those v1 concepts are gone.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Predicate, Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  IntegrationNotFoundError,
  IntegrationSlug,
  InternalError,
  InvalidConnectionInputError,
  OAuthClientSlug,
  Owner,
  ProviderItemId,
  ProviderKey,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params — a connection is identified by (owner, integration, name).
// ---------------------------------------------------------------------------

const ConnectionParams = {
  owner: Owner,
  integration: IntegrationSlug,
  name: ConnectionName,
};

// ---------------------------------------------------------------------------
// Response schemas — mirrors the SDK's `Connection`.
// ---------------------------------------------------------------------------

const ConnectionResponse = Schema.Struct({
  owner: Owner,
  name: ConnectionName,
  integration: IntegrationSlug,
  template: AuthTemplateSlug,
  provider: ProviderKey,
  address: ConnectionAddress,
  identityLabel: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  // The OAuth app that minted this connection (its `oauth_client` slug), or null
  // for static credentials. Lets the UI map a connection back to its app. Just a
  // slug — never a secret.
  oauthClient: Schema.NullOr(OAuthClientSlug),
  oauthClientOwner: Schema.NullOr(Owner),
  oauthScope: Schema.NullOr(Schema.String),
});

const ToolResponse = Schema.Struct({
  address: Schema.String,
  owner: Owner,
  integration: IntegrationSlug,
  connection: ConnectionName,
  name: Schema.String,
  pluginId: Schema.String,
  description: Schema.String,
});

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

// A connection picks exactly one origin: a single pasted `value` (sugar for the
// `token` input), a `values` map (one per named input, e.g. both of Datadog's
// keys), or an external `from` reference.
const CommonCreateFields = {
  owner: Owner,
  name: ConnectionName,
  integration: IntegrationSlug,
  template: AuthTemplateSlug,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
} as const;

// User-curated metadata edits. Absent field = unchanged; null = cleared.
const UpdateConnectionPayload = Schema.Struct({
  description: Schema.optional(Schema.NullOr(Schema.String)),
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
});

const CreateConnectionPayload = Schema.Struct({
  ...CommonCreateFields,
  value: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  from: Schema.optional(
    Schema.Struct({
      provider: ProviderKey,
      id: ProviderItemId,
    }),
  ),
}).check(
  Schema.makeFilter((payload) =>
    [payload.value, payload.values, payload.from].filter(Predicate.isNotUndefined).length === 1
      ? undefined
      : "Expected exactly one credential origin",
  ),
);

// ---------------------------------------------------------------------------
// Query — optional list filters.
// ---------------------------------------------------------------------------

const ListConnectionsQuery = Schema.Struct({
  integration: Schema.optional(IntegrationSlug),
  owner: Schema.optional(Owner),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const ConnectionNotFound = ConnectionNotFoundError.annotate({
  httpApiStatus: 404,
});
const IntegrationNotFound = IntegrationNotFoundError.annotate({
  httpApiStatus: 404,
});
const CredentialProviderNotRegistered = CredentialProviderNotRegisteredError.annotate({
  httpApiStatus: 409,
});
const InvalidConnectionInput = InvalidConnectionInputError.annotate({
  httpApiStatus: 400,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ConnectionsApi = HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get("list", "/connections", {
      query: ListConnectionsQuery,
      success: Schema.Array(ConnectionResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/connections", {
      payload: CreateConnectionPayload,
      success: ConnectionResponse,
      error: [
        InternalError,
        IntegrationNotFound,
        CredentialProviderNotRegistered,
        InvalidConnectionInput,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/connections/:owner/:integration/:name", {
      params: ConnectionParams,
      success: ConnectionResponse,
      error: [InternalError, ConnectionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/connections/:owner/:integration/:name", {
      params: ConnectionParams,
      payload: UpdateConnectionPayload,
      success: ConnectionResponse,
      error: [InternalError, ConnectionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/connections/:owner/:integration/:name", {
      params: ConnectionParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, ConnectionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("refresh", "/connections/:owner/:integration/:name/refresh", {
      params: ConnectionParams,
      success: Schema.Array(ToolResponse),
      error: [InternalError, ConnectionNotFound, IntegrationNotFound],
    }),
  );
