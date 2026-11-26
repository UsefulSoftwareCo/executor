/**
 * OAuth declarations for host protocol 14. Protocol 15 adds a required-on-exchange option to the
 * nested token response, so this schema keeps the path-only declaration protocol 14 accepted.
 */
import { Schema } from "effect";
import { HttpUrl } from "../schema.ts";

const OAuthClientAuth14 = Schema.Literals([
  "none",
  "client_secret_post",
  "client_secret_basic",
  "client_secret_basic_raw",
]);
const OAuthSecretClientAuth14 = Schema.Literals([
  "client_secret_post",
  "client_secret_basic",
  "client_secret_basic_raw",
]);
const OAuthTokenRequestFormat14 = Schema.Literals(["form", "json"]);

const reserved = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "resource",
  "request",
  "request_uri",
]);

const OAuthAuthorizationParams14 = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((params) => Object.keys(params).every((key) => !reserved.has(key)), {
    message: "Authorization parameters cannot replace protocol parameters such as state or scope.",
  }),
);

const declaredAuthorizationQuery14 = Schema.makeFilter(
  (config: {
    readonly authorizationUrl: string;
    readonly authorizationParams?: Readonly<Record<string, string>>;
  }) => {
    const keys = [...new URL(config.authorizationUrl).searchParams.keys()];
    const owned = keys.filter((key) => reserved.has(key));
    if (owned.length > 0)
      return {
        path: ["authorizationUrl"],
        issue: `authorizationUrl cannot set protocol parameters: ${owned.join(", ")}.`,
      };
    const repeated = keys.filter((key) => Object.hasOwn(config.authorizationParams ?? {}, key));
    if (repeated.length > 0)
      return {
        path: ["authorizationParams"],
        issue: `Declare each parameter once; authorizationUrl already sets: ${repeated.join(", ")}.`,
      };
    return undefined;
  },
);

const declaredPkce14 = Schema.makeFilter(
  (config: {
    readonly pkce?: false;
    readonly tokenEndpointAuthMethod?: typeof OAuthClientAuth14.Type;
  }) =>
    config.pkce === false &&
    (config.tokenEndpointAuthMethod === undefined || config.tokenEndpointAuthMethod === "none")
      ? {
          path: ["pkce"],
          issue:
            "pkce: false requires tokenEndpointAuthMethod client_secret_post, client_secret_basic or client_secret_basic_raw.",
        }
      : undefined,
);

const OAuthTokenResponse14 = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^[^.]+(\.[^.]+)*$/)),
});

const tokenRequestOptions14 = {
  scopeSeparator: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  tokenRequestFormat: Schema.optionalKey(OAuthTokenRequestFormat14),
};

const oauthOptions14 = {
  ...tokenRequestOptions14,
  tokenResponse: Schema.optionalKey(OAuthTokenResponse14),
  grant: Schema.optionalKey(Schema.Literal("authorization_code")),
  authorizationParams: Schema.optionalKey(OAuthAuthorizationParams14),
  tokenEndpointAuthMethod: Schema.optionalKey(OAuthClientAuth14),
  resource: Schema.optionalKey(Schema.NullOr(HttpUrl)),
};

export const OAuth2Config14 = Schema.Union([
  Schema.Struct({
    ...oauthOptions14,
    discover: HttpUrl,
    authorizationServerMetadataUrl: Schema.optionalKey(HttpUrl),
    authorizationUrl: Schema.optionalKey(Schema.Never),
    tokenUrl: Schema.optionalKey(Schema.Never),
    revocationUrl: Schema.optionalKey(Schema.Never),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...oauthOptions14,
    authorizationUrl: HttpUrl,
    tokenUrl: HttpUrl,
    revocationUrl: Schema.optionalKey(HttpUrl),
    scopes: Schema.Array(Schema.String),
    issuer: Schema.optionalKey(HttpUrl),
    pkce: Schema.optionalKey(Schema.Literal(false)),
    discover: Schema.optionalKey(Schema.Never),
    authorizationServerMetadataUrl: Schema.optionalKey(Schema.Never),
  }).check(declaredAuthorizationQuery14, declaredPkce14),
  Schema.Struct({
    grant: Schema.Literal("client_credentials"),
    discover: HttpUrl,
    authorizationServerMetadataUrl: Schema.optionalKey(HttpUrl),
    authorizationUrl: Schema.optionalKey(Schema.Never),
    tokenUrl: Schema.optionalKey(Schema.Never),
    revocationUrl: Schema.optionalKey(Schema.Never),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    ...tokenRequestOptions14,
    tokenEndpointAuthMethod: OAuthSecretClientAuth14,
    resource: Schema.optionalKey(Schema.NullOr(HttpUrl)),
  }),
  Schema.Struct({
    grant: Schema.Literal("client_credentials"),
    tokenUrl: HttpUrl,
    revocationUrl: Schema.optionalKey(HttpUrl),
    scopes: Schema.Array(Schema.String),
    ...tokenRequestOptions14,
    tokenEndpointAuthMethod: OAuthSecretClientAuth14,
    resource: Schema.optionalKey(Schema.NullOr(HttpUrl)),
    authorizationUrl: Schema.optionalKey(Schema.Never),
    discover: Schema.optionalKey(Schema.Never),
    authorizationServerMetadataUrl: Schema.optionalKey(Schema.Never),
  }),
]);
