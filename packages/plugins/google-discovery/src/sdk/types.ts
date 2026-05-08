import { Schema } from "effect";
import { SecretBackedValue } from "@executor-js/sdk/core";

export const GoogleDiscoveryHttpMethod = Schema.Literals([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
]);
export type GoogleDiscoveryHttpMethod = typeof GoogleDiscoveryHttpMethod.Type;

export const GoogleDiscoveryParameterLocation = Schema.Literals(["path", "query", "header"]);
export type GoogleDiscoveryParameterLocation = typeof GoogleDiscoveryParameterLocation.Type;

export class GoogleDiscoveryParameter extends Schema.Class<GoogleDiscoveryParameter>(
  "GoogleDiscoveryParameter",
)({
  name: Schema.String,
  location: GoogleDiscoveryParameterLocation,
  required: Schema.Boolean,
  repeated: Schema.Boolean,
  description: Schema.OptionFromOptional(Schema.String),
  schema: Schema.OptionFromOptional(Schema.Unknown),
}) {}

export class GoogleDiscoveryMethodBinding extends Schema.Class<GoogleDiscoveryMethodBinding>(
  "GoogleDiscoveryMethodBinding",
)({
  method: GoogleDiscoveryHttpMethod,
  pathTemplate: Schema.String,
  parameters: Schema.Array(GoogleDiscoveryParameter),
  hasBody: Schema.Boolean,
}) {}

export class GoogleDiscoveryManifestMethod extends Schema.Class<GoogleDiscoveryManifestMethod>(
  "GoogleDiscoveryManifestMethod",
)({
  toolPath: Schema.String,
  description: Schema.OptionFromOptional(Schema.String),
  binding: GoogleDiscoveryMethodBinding,
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  outputSchema: Schema.OptionFromOptional(Schema.Unknown),
  scopes: Schema.Array(Schema.String),
}) {}

export class GoogleDiscoveryManifest extends Schema.Class<GoogleDiscoveryManifest>(
  "GoogleDiscoveryManifest",
)({
  title: Schema.OptionFromOptional(Schema.String),
  service: Schema.String,
  version: Schema.String,
  rootUrl: Schema.String,
  servicePath: Schema.String,
  oauthScopes: Schema.OptionFromOptional(Schema.Record(Schema.String, Schema.String)),
  schemaDefinitions: Schema.Record(Schema.String, Schema.Unknown),
  methods: Schema.Array(GoogleDiscoveryManifestMethod),
}) {}

// ---------------------------------------------------------------------------
// Auth — a source either runs unauthenticated or is backed by a Connection.
//
// The source owns the API-level OAuth config (client credential secret
// ids + scopes) so a stale sign-in can always be re-run from the source
// detail page without needing the prior Connection to still exist. The
// Connection owns live tokens + refresh state (and caches the same
// config on `providerState` for the refresh path). This small
// duplication keeps reconnect fully source-driven.
// ---------------------------------------------------------------------------

export const GoogleDiscoveryAuth = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    /** Connection id; resolve via `ctx.connections.accessToken(id)`.
     *  Rewritten on sign-in to point at the freshly minted connection. */
    connectionId: Schema.String,
    /** Secret id holding the OAuth client_id. */
    clientIdSecretId: Schema.String,
    /** Secret id holding the OAuth client_secret. Null for public clients. */
    clientSecretSecretId: Schema.NullOr(Schema.String),
    /** Scopes requested on sign-in. */
    scopes: Schema.Array(Schema.String),
  }),
]);
export type GoogleDiscoveryAuth = typeof GoogleDiscoveryAuth.Type;

export const GoogleDiscoveryCredentialValue = SecretBackedValue;
export type GoogleDiscoveryCredentialValue = typeof GoogleDiscoveryCredentialValue.Type;

export const GoogleDiscoveryFetchCredentials = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, GoogleDiscoveryCredentialValue)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GoogleDiscoveryCredentialValue)),
});
export type GoogleDiscoveryFetchCredentials = typeof GoogleDiscoveryFetchCredentials.Type;

export class GoogleDiscoveryStoredSourceData extends Schema.Class<GoogleDiscoveryStoredSourceData>(
  "GoogleDiscoveryStoredSourceData",
)({
  name: Schema.String,
  discoveryUrl: Schema.String,
  credentials: Schema.optional(GoogleDiscoveryFetchCredentials),
  service: Schema.String,
  version: Schema.String,
  rootUrl: Schema.String,
  servicePath: Schema.String,
  auth: GoogleDiscoveryAuth,
}) {}

export class GoogleDiscoveryInvocationResult extends Schema.Class<GoogleDiscoveryInvocationResult>(
  "GoogleDiscoveryInvocationResult",
)({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
}) {}

export interface GoogleDiscoverySourceMeta {
  readonly namespace: string;
  readonly name: string;
}
