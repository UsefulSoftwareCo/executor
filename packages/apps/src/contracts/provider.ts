/** Provider declarations use native Effect schemas. The trusted host interprets them. */
import { Data, type Effect, Schema } from "effect";
import { type AccountId, HttpUrl } from "./schema.ts";

/**
 * How app code sees a field of a provider that declares hosts. Unmarked string fields are secret:
 * app code receives sealed handles that only the host's outbound network turns into values.
 * `plain` fields are not secret. `raw` fields are secret, but app code reads the real value.
 */
export type FieldExposure = "plain" | "raw";

/** A named secrets method; its schema retains the provider's own field names. */
export class SecretsMethod<Fields extends Schema.Decoder<unknown>> extends Data.TaggedClass(
  "secrets",
)<{
  readonly label: string;
  readonly fields: Fields;
  /** Fields marked with `plain()` or `raw()`. */
  readonly exposure?: Readonly<Record<string, FieldExposure>>;
}> {}

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
const declaredAuthorizationQuery = Schema.makeFilter(
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
const tokenRequestOptions = {
  /** Joins requested scopes; Linear wants `","`. Defaults to RFC 6749's space. */
  scopeSeparator: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** Encoding of token requests. Defaults to `"form"`; Atlassian, ClickUp and Notion need `"json"`. */
  tokenRequestFormat: Schema.optionalKey(OAuthTokenRequestFormat),
};

const oauthOptions = {
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

/** Default app-visible OAuth projection. Refresh tokens and client secrets remain with the host. */
export const OAuth2AccessToken = Schema.Struct({ access_token: Schema.String });

/** OAuth declaration with an explicit schema for app-visible account fields. */
export class OAuth2Method<Response extends Schema.Decoder<unknown>> extends Data.TaggedClass(
  "oauth2",
)<{
  readonly config: OAuth2Config;
  readonly response: Response;
  /** Response fields marked with `plain()` or `raw()`. */
  readonly exposure?: Readonly<Record<string, FieldExposure>>;
}> {}

/** Supported declarations; these acquire credentials rather than normalize them. */
export type AuthMethod =
  | SecretsMethod<Schema.Decoder<unknown>>
  | OAuth2Method<Schema.Decoder<unknown>>;

/** Auth method names are chosen by the provider author. */
export type AuthMethods = Readonly<Record<string, AuthMethod>>;

const displayText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));

/**
 * Upstream identity that a passing account check may report for display. Only these fields are
 * retained; the host never stores raw provider responses.
 */
export const AccountInfo = Schema.Struct({
  externalId: Schema.optionalKey(displayText),
  displayName: Schema.optionalKey(displayText),
  username: Schema.optionalKey(displayText),
  email: Schema.optionalKey(displayText),
  avatarUrl: Schema.optionalKey(HttpUrl),
  profileUrl: Schema.optionalKey(HttpUrl),
});
export type AccountInfo = typeof AccountInfo.Type;

/** A passing account check. Failures are thrown, so there is no failing variant. */
export const AccountCheckResult = Schema.Struct({ accountInfo: Schema.optionalKey(AccountInfo) });
export type AccountCheckResult = typeof AccountCheckResult.Type;

/** The account a provider's check verifies, with invocation-owned HTTP and cancellation. */
export interface AccountCheckContext<Auth extends AuthMethods> {
  readonly account: AccountOfMethods<Auth>;
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly signal: AbortSignal;
  /**
   * When the host stops waiting for the check, in milliseconds since the epoch. A check still
   * running then fails without its own message, so a check that gives up must do so before it.
   * Executor always sets it; a host that does not limit the check leaves it out.
   */
  readonly deadline?: number;
}

/**
 * A safe authenticated read proving the account works for this app. Returning passes; a thrown
 * `ProviderError` or HTTP status failure classifies the problem. Any other failure, including a
 * timeout, means the check could not verify the account, not that its credentials are bad. A
 * thrown error's own message is shown to the user, bounded and with the checked credentials
 * replaced, so write it for them.
 */
export interface AccountCheck<Auth extends AuthMethods> {
  // Method syntax lets a check typed for specific methods be stored as a general one.
  run(context: AccountCheckContext<Auth>): Effect.Effect<AccountCheckResult | void, unknown>;
}

/** A provider declaration. The host derives its identity from the declaration, never its check. */
export class Provider<Auth extends AuthMethods> extends Data.Class<{
  readonly name: string;
  readonly auth: Auth;
  /**
   * The hosts this provider's credentials may be sent to. When present, secret fields reach app
   * code as handles that the outbound network replaces only on requests to these hosts.
   */
  readonly hosts?: readonly string[];
  /**
   * Stored without its method types so a specific provider still fills a general slot. The host
   * binds the account against this provider's methods before running it.
   */
  readonly health?: AccountCheck<AuthMethods>;
}> {
  /** Declare zero or more accounts from this provider without performing I/O. */
  many(): ManyAccounts<Auth> {
    return new ManyAccounts({ provider: this });
  }
}

/** A collection requirement; selecting accounts does not copy or transfer them. */
export class ManyAccounts<Auth extends AuthMethods> extends Data.TaggedClass("many")<{
  readonly provider: Provider<Auth>;
}> {}

/** Infer the data for one method from its native Effect decoder. */
export type AuthMethodData<Method> =
  Method extends SecretsMethod<infer Fields>
    ? Fields["Type"]
    : Method extends OAuth2Method<infer Response>
      ? Response["Type"]
      : never;

/** One account for these methods, discriminated by its author-chosen method name. */
export type AccountOfMethods<Auth extends AuthMethods> = {
  readonly [Method in keyof Auth & string]: {
    readonly id: AccountId;
    readonly method: Method;
    readonly fields: AuthMethodData<Auth[Method]>;
  };
}[keyof Auth & string];

/** One selected account, discriminated by its author-chosen method name. */
export type AccountOf<P> = P extends Provider<infer Auth> ? AccountOfMethods<Auth> : never;
