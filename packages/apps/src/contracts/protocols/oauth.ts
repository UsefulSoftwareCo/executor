/**
 * OAuth declarations frozen for host protocols 1 through 5. The module imports only `effect`, so
 * no change elsewhere in the repository can alter it. `./oauth-6.ts` holds the declaration later
 * protocols use.
 */
import { Schema } from "effect";

/** Absolute HTTP(S) URL; local HTTP hosts are supported. */
export const HttpUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }),
);

/** How an OAuth client authenticates at the token endpoint; raw Basic is an explicit provider compatibility option. */
export const OAuthClientAuth = Schema.Literals([
  "none",
  "client_secret_post",
  "client_secret_basic",
  "client_secret_basic_raw",
]);
export type OAuthClientAuth = typeof OAuthClientAuth.Type;
/** Machine clients always authenticate; public clients cannot use the client-credentials grant. */
export const OAuthSecretClientAuth = Schema.Literals([
  "client_secret_post",
  "client_secret_basic",
  "client_secret_basic_raw",
]);

/** Parameters the host sets on every authorization request; a declaration cannot replace them. */
export const reservedAuthorizationParams = [
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
] as const;
/** A protocol parameter only the host sets on the authorization request. */
export type ReservedAuthorizationParam = (typeof reservedAuthorizationParams)[number];
const reserved: ReadonlySet<string> = new Set(reservedAuthorizationParams);

/**
 * Extra authorization request parameters, such as `access_type: "offline"`. RFC 6749 §3.1
 * lets services define their own; the protocol and security parameters stay host-owned.
 */
export const OAuthAuthorizationParams = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((params) => Object.keys(params).every((key) => !reserved.has(key)), {
    message: "Authorization parameters cannot replace protocol parameters such as state or scope.",
  }),
);

/**
 * A declared `authorizationUrl` may carry its own query (RFC 6749 §3.1 keeps it). Each parameter
 * is declared once, in the URL or in `authorizationParams`, and never names a host-owned one.
 */
export const declaredAuthorizationQuery = Schema.makeFilter(
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

/** How the token endpoint reads requests. RFC 6749 uses a form; some services want JSON. */
export const OAuthTokenRequestFormat = Schema.Literals(["form", "json"]);
export type OAuthTokenRequestFormat = typeof OAuthTokenRequestFormat.Type;

/**
 * Where a service nests the grant in its token response, as a dot-separated member path. Slack
 * returns a user token under `authed_user`.
 */
export const OAuthTokenResponse = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^[^.]+(\.[^.]+)*$/)),
});
export type OAuthTokenResponse = typeof OAuthTokenResponse.Type;

/** Options for services that differ from RFC 6749 in how they read requests. */
export const tokenRequestOptions = {
  /** Joins requested scopes; Linear wants `","`. Defaults to RFC 6749's space. */
  scopeSeparator: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** Encoding of token requests. Defaults to `"form"`; Atlassian, ClickUp and Notion need `"json"`. */
  tokenRequestFormat: Schema.optionalKey(OAuthTokenRequestFormat),
};

export const oauthOptions = {
  ...tokenRequestOptions,
  /**
   * Read the grant from this nested member of the token response when the top-level response has
   * no access token or no scope. Slack's user tokens use `{ path: "authed_user" }`.
   */
  tokenResponse: Schema.optionalKey(OAuthTokenResponse),
  grant: Schema.optionalKey(Schema.Literal("authorization_code")),
  /**
   * Service-defined authorization request parameters, such as Google's
   * `{ access_type: "offline", prompt: "consent" }`. Host-owned protocol parameters
   * (`state`, `scope`, `redirect_uri`, PKCE and the others in `reservedAuthorizationParams`)
   * are rejected. A discovered endpoint's own query parameter of the same name is replaced.
   */
  authorizationParams: Schema.optionalKey(OAuthAuthorizationParams),
  tokenEndpointAuthMethod: Schema.optionalKey(OAuthClientAuth),
  /** Omitted uses discovery; null explicitly suppresses the resource parameter. */
  resource: Schema.optionalKey(Schema.NullOr(HttpUrl)),
};

/**
 * OAuth endpoints and protocol choices. Omitted grant means authorization code; clients remain
 * host-owned. Declared endpoints may name an RFC 7009 `revocationUrl`; discovery reads the
 * server's `revocation_endpoint` metadata instead.
 */
export const OAuth2Config = Schema.Union([
  Schema.Struct({
    ...oauthOptions,
    discover: HttpUrl,
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
  }).check(declaredAuthorizationQuery),
  Schema.Struct({
    grant: Schema.Literal("client_credentials"),
    discover: HttpUrl,
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
  }),
]);
export type OAuth2Config = typeof OAuth2Config.Type;
