/**
 * OAuth declarations frozen for host protocols 6 onward: `./oauth.ts`'s with an explicit
 * authorization-server metadata URL on discovery. The module imports only `effect` and
 * `./oauth.ts`, so no change elsewhere in the repository can alter it.
 */
import { Schema } from "effect";
import {
  declaredAuthorizationQuery,
  HttpUrl,
  OAuthSecretClientAuth,
  oauthOptions,
  tokenRequestOptions,
} from "./oauth.ts";

/**
 * OAuth endpoints and protocol choices. Omitted grant means authorization code; clients remain
 * host-owned. Declared endpoints may name an RFC 7009 `revocationUrl`; discovery reads the
 * server's `revocation_endpoint` metadata instead.
 */
export const OAuth2Config = Schema.Union([
  Schema.Struct({
    ...oauthOptions,
    discover: HttpUrl,
    /** Fetch this exact metadata document and verify its issuer against discovery. */
    authorizationServerMetadataUrl: Schema.optionalKey(HttpUrl),
    authorizationUrl: Schema.optionalKey(Schema.Never),
    tokenUrl: Schema.optionalKey(Schema.Never),
    revocationUrl: Schema.optionalKey(Schema.Never),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...oauthOptions,
    /** Its query is kept; it cannot set protocol parameters or repeat `authorizationParams`. */
    authorizationUrl: HttpUrl,
    tokenUrl: HttpUrl,
    revocationUrl: Schema.optionalKey(HttpUrl),
    scopes: Schema.Array(Schema.String),
    /** RFC 8414 issuer identifier. Declared issuers are checked against the callback's `iss`. */
    issuer: Schema.optionalKey(HttpUrl),
    discover: Schema.optionalKey(Schema.Never),
    authorizationServerMetadataUrl: Schema.optionalKey(Schema.Never),
  }).check(declaredAuthorizationQuery),
  Schema.Struct({
    grant: Schema.Literal("client_credentials"),
    discover: HttpUrl,
    /** Fetch this exact metadata document and verify its issuer against discovery. */
    authorizationServerMetadataUrl: Schema.optionalKey(HttpUrl),
    authorizationUrl: Schema.optionalKey(Schema.Never),
    tokenUrl: Schema.optionalKey(Schema.Never),
    revocationUrl: Schema.optionalKey(Schema.Never),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    ...tokenRequestOptions,
    tokenEndpointAuthMethod: OAuthSecretClientAuth,
    resource: Schema.optionalKey(Schema.NullOr(HttpUrl)),
  }),
  Schema.Struct({
    grant: Schema.Literal("client_credentials"),
    tokenUrl: HttpUrl,
    revocationUrl: Schema.optionalKey(HttpUrl),
    scopes: Schema.Array(Schema.String),
    ...tokenRequestOptions,
    tokenEndpointAuthMethod: OAuthSecretClientAuth,
    resource: Schema.optionalKey(Schema.NullOr(HttpUrl)),
    authorizationUrl: Schema.optionalKey(Schema.Never),
    discover: Schema.optionalKey(Schema.Never),
    authorizationServerMetadataUrl: Schema.optionalKey(Schema.Never),
  }),
]);
export type OAuth2Config = typeof OAuth2Config.Type;
