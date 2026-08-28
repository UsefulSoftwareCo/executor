import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Option, Predicate, Ref, Schema, Scope } from "effect";
import { createHash, randomUUID } from "node:crypto";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  ID_JAG_GRANT_PROFILE_URN,
  ID_JAG_TOKEN_TYPE_URN,
  JWT_BEARER_GRANT_TYPE_URN,
  TOKEN_EXCHANGE_GRANT_TYPE_URN,
  createIdJagSigningKey,
  jwksDocumentFor,
  signIdJag,
  verifyIdJag,
} from "./id-jag-test-support";

export class OAuthTestServerAddressError extends Data.TaggedError("OAuthTestServerAddressError")<{
  readonly address: unknown;
}> {}

export class OAuthTestServerFlowError extends Data.TaggedError("OAuthTestServerFlowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface OAuthAuthorizationCompletion {
  readonly callbackUrl: string;
  readonly code: string;
  readonly state: string;
}

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly scope?: string;
}

export interface OAuthTestServerRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface OAuthTestServerOptions {
  readonly users?: Readonly<Record<string, string>>;
  readonly defaultUsername?: string;
  readonly defaultPassword?: string;
  readonly defaultClientId?: string;
  readonly defaultClientSecret?: string;
  readonly clients?: Readonly<Record<string, string | null>>;
  readonly scopes?: readonly string[];
  readonly omitTokenResponseScopes?: readonly string[];
  readonly supportRefresh?: boolean;
  /** Whether the authorization-code grant ISSUES a refresh token at all.
   *  Default true. Set false to stand in for an identity provider that hands
   *  back only an access + ID token, which is the case that forces work-identity
   *  custody onto the (expiring) ID token. Distinct from `supportRefresh`, which
   *  governs whether an ISSUED refresh token can still be redeemed. */
  readonly issueRefreshToken?: boolean;
  readonly tokenExpiresInSeconds?: number;
  readonly invalidRefreshTokenDescription?: string;
  /** RFC 6749 error code returned when a refresh-token grant is rejected.
   *  Defaults to `invalid_grant`; set to e.g. `invalid_request` to mirror
   *  authorization servers that reject dead refresh tokens with other codes. */
  readonly invalidRefreshTokenErrorCode?: string;
  /** Answer a rejected refresh-token grant with this EXACT response instead of
   *  the conform §5.2 JSON envelope, byte for byte. Production token endpoints
   *  refuse dead grants in shapes the spec never describes — a `text/plain` 400
   *  ("your session has expired"), a `text/plain` 404, or a GitHub-style HTTP
   *  200 whose body carries the error — and executor has to read all of them as
   *  the same definitive refusal. Takes precedence over
   *  `invalidRefreshTokenErrorCode` / `invalidRefreshTokenDescription`. */
  readonly refreshRejection?: {
    readonly status: number;
    /** Defaults to `text/plain; charset=utf-8`. */
    readonly contentType?: string;
    readonly body: string;
  };
  readonly idTokenClaims?: Readonly<Record<string, unknown>>;
  readonly refreshIdTokenClaims?: Readonly<Record<string, unknown>>;
  /** Gate Dynamic Client Registration on the requested redirect URIs. When set,
   *  `/register` returns `400 invalid_redirect_uri` unless every requested
   *  `redirect_uris` entry is approved. Mirrors authorization servers (e.g.
   *  Vercel) that only accept loopback redirect URIs for anonymous DCR. */
  readonly approveRedirectUri?: (uri: string) => boolean;
  /** Gate Dynamic Client Registration on the requested `client_name`. When set,
   *  `/register` returns `400 invalid_client_metadata` unless the requested
   *  name is approved. Mirrors authorization servers (e.g. Mercury) that
   *  reject third-party client names containing their own brand. */
  readonly approveClientName?: (name: string) => boolean;
  /** Act as an enterprise IdP Authorization Server for the Identity Assertion
   *  JWT Authorization Grant: accept RFC 8693 token exchanges, mint signed
   *  ID-JAGs, and publish the JWKS that verifies them. */
  readonly enterpriseIdp?: EnterpriseIdpOptions;
  /** Act as a Resource Authorization Server for the same profile: advertise it
   *  in RFC 8414 metadata and redeem ID-JAGs presented as RFC 7523 assertions. */
  readonly enterpriseResourceServer?: EnterpriseResourceServerOptions;
  /** Advertise OAuth Client ID Metadata Document support alongside DCR. */
  readonly clientIdMetadataDocumentSupported?: boolean;
}

export interface EnterpriseIdpOptions {
  /** Refuse every exchange with this RFC 6749 §5.2 error, standing in for an
   *  administrator policy that does not permit this client/user/target. */
  readonly denyExchangeWith?: { readonly error: string; readonly errorDescription: string };
  /** Lifetime stamped on the minted ID-JAG. May be zero or negative so a test
   *  can present an already-expired assertion. Default 300 (draft §4.3.4). */
  readonly idJagExpiresInSeconds?: number;
  /** JWT header `typ` to stamp. Default `oauth-id-jag+jwt`; override to prove a
   *  Resource Authorization Server rejects a wrongly-typed assertion. */
  readonly assertionTyp?: string;
  /** Scope the IdP actually grants, standing in for policy narrowing (§4.3.3).
   *  Omitted means "exactly what was requested". */
  readonly grantScope?: (requested: string | null) => string | null;
  /** draft §5: the IdP knows which `client_id` the Resource Authorization
   *  Server registered for this client, which need not be the id the client
   *  authenticates to the IdP with. Maps IdP client id to resource client id;
   *  an unmapped client keeps its own id. */
  readonly resourceClientIds?: Readonly<Record<string, string>>;
}

export interface EnterpriseResourceServerOptions {
  /** The enterprise IdP whose JWKS signs assertions this server will accept.
   *  Resolved through the IdP's own RFC 8414 metadata, as a real server would. */
  readonly trustedIdpIssuer: string;
  /** Scope this server is willing to grant. An assertion carrying more is
   *  narrowed to the intersection (draft §4.4.1). Omitted grants what the
   *  assertion carries. */
  readonly grantableScopes?: readonly string[];
}

export interface OAuthTestServerShape {
  readonly issuerUrl: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly protectedResourceMetadataUrl: string;
  readonly resourceUrl: string;
  readonly mcpResourceUrl: string;
  readonly completeAuthorizationCodeFlow: (input: {
    readonly authorizationUrl: string;
    readonly username?: string;
    readonly password?: string;
  }) => Effect.Effect<OAuthAuthorizationCompletion, OAuthTestServerFlowError>;
  readonly completeAuthorizationCodeTokenFlow: (input?: {
    readonly username?: string;
    readonly password?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly redirectUrl?: string;
    readonly scopes?: readonly string[];
    readonly resource?: string;
  }) => Effect.Effect<OAuthTokenSet, OAuthTestServerFlowError>;
  readonly requests: Effect.Effect<readonly OAuthTestServerRequest[]>;
  readonly clearRequests: Effect.Effect<void>;
  readonly issuedAccessTokens: Effect.Effect<readonly string[]>;
  readonly acceptsAccessToken: (token: string) => Effect.Effect<boolean>;
  /** Stop honouring a token this server issued, without re-issuing anything.
   *  Drives the "the stored identity assertion died" tier: an enterprise IdP
   *  fixture rejects the exchange afterwards exactly as it would for an expired
   *  or revoked assertion. */
  readonly revokeAccessToken: (token: string) => Effect.Effect<void>;
  /** Stop honouring every refresh token this server issued to a client, and
   *  report how many that was. Models the enterprise-side action a client cannot
   *  see: an administrator ends the user's sessions, and the next ID-JAG exchange
   *  presenting one of those refresh tokens is rejected as `invalid_grant`.
   *
   *  Keyed by CLIENT rather than by token value on purpose — a test driving this
   *  holds no refresh token (custody is the server's), so revoking by value would
   *  force it to reach into private state to find one. */
  readonly revokeRefreshTokensFor: (clientId: string) => Effect.Effect<number>;
  /** Start (or stop) refusing every RFC 8693 exchange with this §5.2 error.
   *  `enterpriseIdp.denyExchangeWith` sets the same policy up front; this drives
   *  the case that only exists over time — an administrator withdrawing access
   *  AFTER a connection was made, which the credential-refresh path meets. */
  readonly setTokenExchangeDenial: (
    denial: { readonly error: string; readonly errorDescription: string } | null,
  ) => Effect.Effect<void>;
  readonly acceptsAuthorizationHeader: (
    authorization: string | null | undefined,
  ) => Effect.Effect<boolean>;
}

interface ClientRecord {
  readonly clientSecret: string | null;
  readonly redirectUris: ReadonlySet<string>;
  readonly tokenEndpointAuthMethod: string;
}

interface AuthorizationTransaction {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scope: string | null;
  readonly resource: string | null;
}

interface AuthorizationCodeRecord extends AuthorizationTransaction {
  readonly username: string;
}

interface RefreshTokenRecord {
  readonly clientId: string;
  readonly username: string;
  readonly scope: string | null;
  readonly resource: string | null;
}

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

const defaultScopes = ["read", "write"] as const;

const jsonResponse = (
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status, headers });

const textResponse = (
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, {
    status,
    headers,
    contentType: "text/plain; charset=utf-8",
  });

const redirectResponse = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location);

const parseJsonObject = (body: string): Readonly<Record<string, unknown>> | null => {
  const result = decodeJsonObject(body);
  return Option.isSome(result) ? result.value : null;
};

const arrayOfStrings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const decodeBasicAuthorization = (
  value: string | undefined,
): { readonly username: string; readonly password: string } | null => {
  if (!value) return null;
  const match = /^Basic\s+(.+)$/i.exec(value);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
};

const codeChallengeForVerifier = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

const jwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const unsignedJwt = (claims: Readonly<Record<string, unknown>>): string =>
  `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart(claims)}.sig`;

const oauthError = (status: number, error: string, errorDescription: string) =>
  jsonResponse(
    status,
    {
      error,
      error_description: errorDescription,
    },
    status === 401 ? { "www-authenticate": 'Basic realm="OAuth test server"' } : {},
  );

const manualRedirectHttpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
);

const executeManualRedirect = (
  request: HttpClientRequest.HttpClientRequest,
  requestUrl: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, OAuthTestServerFlowError> =>
  HttpClient.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new OAuthTestServerFlowError({
          message: `OAuth test flow request failed for ${requestUrl}`,
          cause,
        }),
    ),
    Effect.provide(manualRedirectHttpClientLayer),
  );

const executeOAuthHttp = (
  request: HttpClientRequest.HttpClientRequest,
  requestUrl: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, OAuthTestServerFlowError> =>
  HttpClient.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new OAuthTestServerFlowError({
          message: `OAuth test flow request failed for ${requestUrl}`,
          cause,
        }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

const requiredRedirectLocation = (
  response: HttpClientResponse.HttpClientResponse,
  requestUrl: string,
): Effect.Effect<string, OAuthTestServerFlowError> =>
  Effect.gen(function* () {
    if (response.status < 300 || response.status >= 400) {
      return yield* new OAuthTestServerFlowError({
        message: `Expected redirect from ${requestUrl}, got HTTP ${response.status}`,
      });
    }
    const location = response.headers.location;
    if (!location) {
      return yield* new OAuthTestServerFlowError({
        message: `Expected Location header from ${requestUrl}`,
      });
    }
    return new URL(location, requestUrl).toString();
  });

const serveOAuthTestHttpApp = (
  handler: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
): Effect.Effect<{ readonly baseUrl: string }, OAuthTestServerAddressError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.fresh(
        HttpServer.serve(
          HttpServerRequest.HttpServerRequest.asEffect().pipe(Effect.flatMap(handler)),
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    ).pipe(Effect.mapError((address) => new OAuthTestServerAddressError({ address })));
    const server = Context.get(context, HttpServer.HttpServer);
    const address = server.address;
    if (!Predicate.isTagged(address, "TcpAddress")) {
      return yield* new OAuthTestServerAddressError({ address });
    }
    return { baseUrl: `http://127.0.0.1:${address.port}` };
  });

const requestBodyText = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<string> =>
  request.text.pipe(Effect.catch(() => Effect.succeed("")));

const completeAuthorizationCodeFlow =
  (defaults: { readonly username: string; readonly password: string }) =>
  (input: {
    readonly authorizationUrl: string;
    readonly username?: string;
    readonly password?: string;
  }): Effect.Effect<OAuthAuthorizationCompletion, OAuthTestServerFlowError> =>
    Effect.gen(function* () {
      const loginResponse = yield* executeManualRedirect(
        HttpClientRequest.get(input.authorizationUrl),
        input.authorizationUrl,
      );
      const loginUrl = yield* requiredRedirectLocation(loginResponse, input.authorizationUrl);
      const credentials = Buffer.from(
        `${input.username ?? defaults.username}:${input.password ?? defaults.password}`,
      ).toString("base64");
      const callbackResponse = yield* executeManualRedirect(
        HttpClientRequest.post(loginUrl).pipe(
          HttpClientRequest.setHeader("authorization", `Basic ${credentials}`),
        ),
        loginUrl,
      );
      const callbackUrl = yield* requiredRedirectLocation(callbackResponse, loginUrl);
      const parsed = new URL(callbackUrl);
      const state = parsed.searchParams.get("state");
      const code = parsed.searchParams.get("code");
      if (!state || !code) {
        return yield* new OAuthTestServerFlowError({
          message: "OAuth callback did not include both state and code",
        });
      }
      return { callbackUrl, state, code };
    });

const completeAuthorizationCodeTokenFlow =
  (defaults: {
    readonly username: string;
    readonly password: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
  }) =>
  (
    input: {
      readonly username?: string;
      readonly password?: string;
      readonly clientId?: string;
      readonly clientSecret?: string;
      readonly redirectUrl?: string;
      readonly scopes?: readonly string[];
      readonly resource?: string;
    } = {},
  ): Effect.Effect<OAuthTokenSet, OAuthTestServerFlowError> =>
    Effect.gen(function* () {
      const clientId = input.clientId ?? defaults.clientId;
      const clientSecret = input.clientSecret ?? defaults.clientSecret;
      const redirectUrl = input.redirectUrl ?? "http://127.0.0.1/callback";
      const codeVerifier = `verifier_${randomUUID()}`;
      const state = `state_${randomUUID()}`;
      const authorizationUrl = new URL(defaults.authorizationEndpoint);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("code_challenge", codeChallengeForVerifier(codeVerifier));
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      if (input.scopes && input.scopes.length > 0) {
        authorizationUrl.searchParams.set("scope", input.scopes.join(" "));
      }
      if (input.resource) {
        authorizationUrl.searchParams.set("resource", input.resource);
      }

      const callback = yield* completeAuthorizationCodeFlow({
        username: defaults.username,
        password: defaults.password,
      })({
        authorizationUrl: authorizationUrl.toString(),
        username: input.username,
        password: input.password,
      });
      const tokenResponse = yield* executeOAuthHttp(
        HttpClientRequest.post(defaults.tokenEndpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "authorization_code",
            code: callback.code,
            redirect_uri: redirectUrl,
            client_id: clientId,
            client_secret: clientSecret,
            code_verifier: codeVerifier,
          }),
        ),
        defaults.tokenEndpoint,
      );
      if (tokenResponse.status !== 200) {
        const body = yield* tokenResponse.text.pipe(
          Effect.catch(() => Effect.succeed("<unavailable>")),
        );
        return yield* new OAuthTestServerFlowError({
          message: `Expected token response HTTP 200, got HTTP ${tokenResponse.status}: ${body}`,
        });
      }
      const raw = yield* tokenResponse.json.pipe(
        Effect.mapError(
          (cause) =>
            new OAuthTestServerFlowError({
              message: "OAuth token response was not valid JSON",
              cause,
            }),
        ),
      );
      const token = yield* decodeTokenResponse(raw).pipe(
        Effect.mapError(
          (cause) =>
            new OAuthTestServerFlowError({
              message: "OAuth token response did not match the expected shape",
              cause,
            }),
        ),
      );
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenType: token.token_type,
        expiresIn: token.expires_in,
        scope: token.scope,
      };
    });

/** RFC 8693 §3 subject token types this fixture accepts on a token exchange.
 *  Anything else is `invalid_request`, so a client that invents a type finds
 *  out here rather than against a lenient deployment. */
const SUPPORTED_SUBJECT_TOKEN_TYPES = new Set([
  "urn:ietf:params:oauth:token-type:id_token",
  "urn:ietf:params:oauth:token-type:saml2",
  "urn:ietf:params:oauth:token-type:refresh_token",
  "urn:ietf:params:oauth:token-type:access_token",
]);

const JwksUriMetadata = Schema.Struct({ jwks_uri: Schema.String });
const decodeJwksUriMetadata = Schema.decodeUnknownOption(JwksUriMetadata);

/** Resolve a trusted IdP's signing keys the way a Resource Authorization Server
 *  does: read its RFC 8414 metadata, follow `jwks_uri`, fetch the key set. Any
 *  failure yields `None`, which the caller reports as `invalid_grant` — the
 *  fixture never falls back to trusting an unverified assertion. */
const fetchTrustedIdpJwks = (issuer: string): Effect.Effect<Option.Option<unknown>> =>
  Effect.gen(function* () {
    const metadataUrl = `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
    const metadataResponse = yield* executeOAuthHttp(
      HttpClientRequest.get(metadataUrl),
      metadataUrl,
    );
    if (metadataResponse.status !== 200) return Option.none();
    const metadata = yield* metadataResponse.json;
    const decoded = decodeJwksUriMetadata(metadata);
    if (Option.isNone(decoded)) return Option.none();
    const jwksResponse = yield* executeOAuthHttp(
      HttpClientRequest.get(decoded.value.jwks_uri),
      decoded.value.jwks_uri,
    );
    if (jwksResponse.status !== 200) return Option.none();
    return Option.some(yield* jwksResponse.json);
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

/** Parse the `scope` query param from an authorize URL into an ordered list
 *  (empty when the parameter is absent or blank). */
export const scopesFromAuthorizeUrl = (authorizationUrl: string): readonly string[] => {
  const raw = new URL(authorizationUrl).searchParams.get("scope");
  return raw == null || raw.length === 0 ? [] : raw.split(" ");
};

export const serveOAuthTestServer = (
  options: OAuthTestServerOptions = {},
): Effect.Effect<OAuthTestServerShape, OAuthTestServerAddressError, Scope.Scope> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly OAuthTestServerRequest[]>([]);
    const issuedAccessTokens = yield* Ref.make<ReadonlySet<string>>(new Set());
    const users = {
      [options.defaultUsername ?? "alice"]: options.defaultPassword ?? "password",
      ...(options.users ?? {}),
    };
    const supportRefresh = options.supportRefresh ?? true;
    const issueRefreshToken = options.issueRefreshToken ?? true;
    const tokenExpiresInSeconds = options.tokenExpiresInSeconds ?? 3600;
    const invalidRefreshTokenDescription =
      options.invalidRefreshTokenDescription ?? "Unknown refresh token";
    const invalidRefreshTokenErrorCode = options.invalidRefreshTokenErrorCode ?? "invalid_grant";
    const scopes = options.scopes ?? defaultScopes;
    const omittedTokenResponseScopes = new Set(options.omitTokenResponseScopes ?? []);
    const tokenResponseScope = (scope: string | null): string | undefined => {
      if (!scope) return undefined;
      const filtered = scope
        .split(/\s+/)
        .filter((item) => item.length > 0 && !omittedTokenResponseScopes.has(item));
      return filtered.length > 0 ? filtered.join(" ") : undefined;
    };
    const clients = new Map<string, ClientRecord>();
    const transactions = new Map<string, AuthorizationTransaction>();
    const authorizationCodes = new Map<string, AuthorizationCodeRecord>();
    const refreshTokens = new Map<string, RefreshTokenRecord>();
    const defaultClientId = options.defaultClientId ?? "test-client";
    const defaultClientSecret = options.defaultClientSecret ?? "test-secret";

    clients.set(defaultClientId, {
      clientSecret: defaultClientSecret,
      redirectUris: new Set(),
      tokenEndpointAuthMethod: "client_secret_post",
    });
    for (const [clientId, clientSecret] of Object.entries(options.clients ?? {})) {
      clients.set(clientId, {
        clientSecret,
        redirectUris: new Set(),
        tokenEndpointAuthMethod: clientSecret === null ? "none" : "client_secret_post",
      });
    }

    // Only generate a keypair for a server that actually plays the IdP role —
    // RSA generation is not free, and every other fixture in the suite would
    // pay for it otherwise.
    const idJagKey = options.enterpriseIdp ? createIdJagSigningKey() : null;
    const idJagLifetimeSeconds = options.enterpriseIdp?.idJagExpiresInSeconds ?? 300;
    // Policy is state, not configuration: an administrator can withdraw access
    // between one exchange and the next, and the fixture has to be able to say so.
    const tokenExchangeDenial = yield* Ref.make<{
      readonly error: string;
      readonly errorDescription: string;
    } | null>(options.enterpriseIdp?.denyExchangeWith ?? null);

    let issuerUrl = "";
    const server = yield* serveOAuthTestHttpApp((request) =>
      Effect.gen(function* () {
        const currentIssuerUrl = issuerUrl || "http://127.0.0.1";
        const requestUrl = new URL(request.url, currentIssuerUrl);
        const body = yield* requestBodyText(request);
        const headers = request.headers;

        yield* Ref.update(requests, (all) => [
          ...all,
          {
            method: request.method,
            url: requestUrl.toString(),
            path: requestUrl.pathname,
            headers,
            body,
            query: Object.fromEntries(requestUrl.searchParams.entries()),
          },
        ]);

        if (requestUrl.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          const suffix = requestUrl.pathname.slice("/.well-known/oauth-protected-resource".length);
          const resource = `${currentIssuerUrl}${suffix}`;
          return jsonResponse(200, {
            resource,
            authorization_servers: [currentIssuerUrl],
            bearer_methods_supported: ["header"],
            scopes_supported: scopes,
          });
        }

        if (requestUrl.pathname === "/jwks" && idJagKey) {
          return jsonResponse(200, jwksDocumentFor(idJagKey));
        }

        if (
          requestUrl.pathname === "/.well-known/oauth-authorization-server" ||
          requestUrl.pathname === "/.well-known/openid-configuration"
        ) {
          return jsonResponse(200, {
            issuer: currentIssuerUrl,
            authorization_endpoint: `${currentIssuerUrl}/authorize`,
            token_endpoint: `${currentIssuerUrl}/token`,
            registration_endpoint: `${currentIssuerUrl}/register`,
            ...(options.clientIdMetadataDocumentSupported === true
              ? { client_id_metadata_document_supported: true }
              : {}),
            response_types_supported: ["code"],
            grant_types_supported: [
              "authorization_code",
              "refresh_token",
              "client_credentials",
              ...(options.enterpriseIdp ? [TOKEN_EXCHANGE_GRANT_TYPE_URN] : []),
              // draft §7.2: a server advertising the ID-JAG profile MUST also
              // advertise the jwt-bearer grant type.
              ...(options.enterpriseResourceServer ? [JWT_BEARER_GRANT_TYPE_URN] : []),
            ],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: [
              "none",
              "client_secret_post",
              "client_secret_basic",
            ],
            scopes_supported: scopes,
            ...(idJagKey ? { jwks_uri: `${currentIssuerUrl}/jwks` } : {}),
            ...(options.enterpriseIdp
              ? {
                  identity_chaining_requested_token_types_supported: [ID_JAG_TOKEN_TYPE_URN],
                }
              : {}),
            ...(options.enterpriseResourceServer
              ? { authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE_URN] }
              : {}),
          });
        }

        if (requestUrl.pathname === "/register" && request.method === "POST") {
          const json = parseJsonObject(body);
          if (!json) {
            return oauthError(400, "invalid_client_metadata", "Expected JSON body");
          }
          const requestedClientName = typeof json.client_name === "string" ? json.client_name : "";
          if (options.approveClientName && !options.approveClientName(requestedClientName)) {
            return oauthError(
              400,
              "invalid_client_metadata",
              "The requested client_name is not allowed by this authorization server.",
            );
          }
          const requestedMethod =
            typeof json.token_endpoint_auth_method === "string"
              ? json.token_endpoint_auth_method
              : "none";
          const clientId = `client_${randomUUID()}`;
          const clientSecret =
            requestedMethod === "client_secret_basic" || requestedMethod === "client_secret_post"
              ? `secret_${randomUUID()}`
              : null;
          const redirectUris = new Set(arrayOfStrings(json.redirect_uris));
          if (
            options.approveRedirectUri &&
            [...redirectUris].some((uri) => !options.approveRedirectUri!(uri))
          ) {
            return oauthError(
              400,
              "invalid_redirect_uri",
              "The provided redirect URIs are not approved for use by this authorization server.",
            );
          }
          clients.set(clientId, {
            clientSecret,
            redirectUris,
            tokenEndpointAuthMethod: requestedMethod,
          });
          return jsonResponse(
            201,
            {
              client_id: clientId,
              ...(clientSecret ? { client_secret: clientSecret } : {}),
              client_id_issued_at: Math.floor(Date.now() / 1000),
              token_endpoint_auth_method: requestedMethod,
              redirect_uris: [...redirectUris],
              grant_types: arrayOfStrings(json.grant_types),
              response_types: arrayOfStrings(json.response_types),
              scope: typeof json.scope === "string" ? json.scope : scopes.join(" "),
            },
            { "cache-control": "no-store" },
          );
        }

        if (requestUrl.pathname === "/authorize" && request.method === "GET") {
          const clientId = requestUrl.searchParams.get("client_id");
          const redirectUri = requestUrl.searchParams.get("redirect_uri");
          const state = requestUrl.searchParams.get("state");
          const codeChallenge = requestUrl.searchParams.get("code_challenge");
          const responseType = requestUrl.searchParams.get("response_type");
          if (!clientId || !redirectUri || !state || !codeChallenge || responseType !== "code") {
            return oauthError(400, "invalid_request", "Missing authorization parameters");
          }
          const client = clients.get(clientId);
          if (client && client.redirectUris.size > 0 && !client.redirectUris.has(redirectUri)) {
            return oauthError(400, "invalid_request", "redirect_uri is not registered");
          }
          if (!client) {
            clients.set(clientId, {
              clientSecret: null,
              redirectUris: new Set([redirectUri]),
              tokenEndpointAuthMethod: "none",
            });
          }
          const transaction = `txn_${randomUUID()}`;
          transactions.set(transaction, {
            clientId,
            redirectUri,
            state,
            codeChallenge,
            scope: requestUrl.searchParams.get("scope"),
            resource: requestUrl.searchParams.get("resource"),
          });
          return redirectResponse(
            `${currentIssuerUrl}/login?transaction=${encodeURIComponent(transaction)}`,
          );
        }

        if (requestUrl.pathname === "/login") {
          const transactionId = requestUrl.searchParams.get("transaction");
          const transaction = transactionId ? transactions.get(transactionId) : undefined;
          if (!transactionId || !transaction) {
            return oauthError(400, "invalid_request", "Unknown login transaction");
          }
          if (request.method === "GET") {
            return textResponse(200, "OAuth test login");
          }
          const basic = decodeBasicAuthorization(headers.authorization);
          if (!basic || users[basic.username] !== basic.password) {
            return jsonResponse(
              401,
              { error: "access_denied" },
              { "www-authenticate": 'Basic realm="OAuth test server"' },
            );
          }
          const code = `code_${randomUUID()}`;
          transactions.delete(transactionId);
          authorizationCodes.set(code, { ...transaction, username: basic.username });
          const callbackUrl = new URL(transaction.redirectUri);
          callbackUrl.searchParams.set("code", code);
          callbackUrl.searchParams.set("state", transaction.state);
          return redirectResponse(callbackUrl.toString());
        }

        if (requestUrl.pathname === "/token" && request.method === "POST") {
          const params = new URLSearchParams(body);
          const basic = decodeBasicAuthorization(headers.authorization);
          const clientId = basic?.username ?? params.get("client_id");
          const clientSecret = basic?.password ?? params.get("client_secret");
          const client = clientId ? clients.get(clientId) : undefined;
          if (!clientId || !client) {
            return oauthError(401, "invalid_client", "Unknown client");
          }
          if (client.clientSecret !== null && client.clientSecret !== clientSecret) {
            return oauthError(401, "invalid_client", "Invalid client secret");
          }

          const grantType = params.get("grant_type");
          if (grantType === "authorization_code") {
            const code = params.get("code");
            const redirectUri = params.get("redirect_uri");
            const codeVerifier = params.get("code_verifier");
            const record = code ? authorizationCodes.get(code) : undefined;
            if (!code || !redirectUri || !codeVerifier || !record) {
              return oauthError(400, "invalid_grant", "Unknown authorization code");
            }
            if (
              record.clientId !== clientId ||
              record.redirectUri !== redirectUri ||
              record.codeChallenge !== codeChallengeForVerifier(codeVerifier)
            ) {
              return oauthError(400, "invalid_grant", "Authorization code validation failed");
            }
            authorizationCodes.delete(code);
            const accessToken = `at_${randomUUID()}`;
            const refreshToken = issueRefreshToken ? `rt_${randomUUID()}` : null;
            yield* Ref.update(issuedAccessTokens, (tokens) => new Set([...tokens, accessToken]));
            if (refreshToken !== null) {
              refreshTokens.set(refreshToken, {
                clientId,
                username: record.username,
                scope: record.scope,
                resource: record.resource,
              });
            }
            const scope = tokenResponseScope(record.scope);
            return jsonResponse(
              200,
              {
                access_token: accessToken,
                ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
                token_type: "Bearer",
                expires_in: tokenExpiresInSeconds,
                ...(scope ? { scope } : {}),
                ...(options.idTokenClaims ? { id_token: unsignedJwt(options.idTokenClaims) } : {}),
              },
              { "cache-control": "no-store" },
            );
          }

          if (grantType === "refresh_token") {
            const refreshToken = params.get("refresh_token");
            const record = refreshToken ? refreshTokens.get(refreshToken) : undefined;
            if (!supportRefresh || !refreshToken || !record || record.clientId !== clientId) {
              const rejection = options.refreshRejection;
              return rejection
                ? HttpServerResponse.text(rejection.body, {
                    status: rejection.status,
                    contentType: rejection.contentType ?? "text/plain; charset=utf-8",
                  })
                : oauthError(400, invalidRefreshTokenErrorCode, invalidRefreshTokenDescription);
            }
            const nextAccessToken = `at_${randomUUID()}`;
            const nextRefreshToken = `rt_${randomUUID()}`;
            refreshTokens.delete(refreshToken);
            refreshTokens.set(nextRefreshToken, record);
            yield* Ref.update(
              issuedAccessTokens,
              (tokens) => new Set([...tokens, nextAccessToken]),
            );
            const scope = tokenResponseScope(record.scope);
            return jsonResponse(
              200,
              {
                access_token: nextAccessToken,
                refresh_token: nextRefreshToken,
                token_type: "Bearer",
                expires_in: tokenExpiresInSeconds,
                ...(scope ? { scope } : {}),
                ...(options.refreshIdTokenClaims
                  ? { id_token: unsignedJwt(options.refreshIdTokenClaims) }
                  : {}),
              },
              { "cache-control": "no-store" },
            );
          }

          if (grantType === "client_credentials") {
            const accessToken = `at_${randomUUID()}`;
            yield* Ref.update(issuedAccessTokens, (tokens) => new Set([...tokens, accessToken]));
            return jsonResponse(
              200,
              {
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: tokenExpiresInSeconds,
                scope: params.get("scope") ?? scopes.join(" "),
              },
              { "cache-control": "no-store" },
            );
          }

          // RFC 8693 token exchange → ID-JAG (draft §4.3). The subject token is
          // an access token THIS server issued: that makes "the identity
          // assertion expired" expressible (revoke it) without inventing a
          // second credential store.
          if (grantType === TOKEN_EXCHANGE_GRANT_TYPE_URN) {
            const idp = options.enterpriseIdp;
            if (!idp || !idJagKey) {
              return oauthError(
                400,
                "unsupported_grant_type",
                "This authorization server does not issue identity assertion grants",
              );
            }
            if (params.get("requested_token_type") !== ID_JAG_TOKEN_TYPE_URN) {
              return oauthError(
                400,
                "invalid_request",
                `requested_token_type must be ${ID_JAG_TOKEN_TYPE_URN}`,
              );
            }
            const audience = params.get("audience");
            if (!audience) {
              return oauthError(400, "invalid_request", "audience is required");
            }
            const subjectToken = params.get("subject_token");
            const subjectTokenType = params.get("subject_token_type");
            if (!subjectToken || !subjectTokenType) {
              return oauthError(
                400,
                "invalid_request",
                "subject_token and subject_token_type are required",
              );
            }
            if (!SUPPORTED_SUBJECT_TOKEN_TYPES.has(subjectTokenType)) {
              return oauthError(
                400,
                "invalid_request",
                `Unsupported subject_token_type ${subjectTokenType}`,
              );
            }
            // Policy is evaluated BEFORE the subject token, so a denial cannot
            // be mistaken for a credential problem by a client that only looks
            // at the first failing check.
            const denial = yield* Ref.get(tokenExchangeDenial);
            if (denial) {
              return oauthError(400, denial.error, denial.errorDescription);
            }
            // draft §4.5: a REFRESH token is a first-class subject, and it is
            // VALIDATED, NOT CONSUMED — the exchange is not a refresh-token
            // grant and must not rotate the client's durable subject out from
            // under it. (Matches the Okta emulator's behavior, which this
            // fixture stands in for in the hermetic tests.) A refresh token is
            // also only acceptable from the client it was issued to.
            const subjectAccepted =
              subjectTokenType === "urn:ietf:params:oauth:token-type:refresh_token"
                ? refreshTokens.get(subjectToken)?.clientId === clientId
                : yield* Ref.get(issuedAccessTokens).pipe(
                    Effect.map((tokens) => tokens.has(subjectToken)),
                  );
            if (!subjectAccepted) {
              return oauthError(
                400,
                "invalid_grant",
                "The subject token is expired, revoked, or was not issued by this identity provider",
              );
            }
            const requestedScope = params.get("scope");
            const grantedScope = idp.grantScope ? idp.grantScope(requestedScope) : requestedScope;
            const resourceParam = params.get("resource");
            const issuedAtSeconds = Math.floor(Date.now() / 1000);
            const assertion = signIdJag({
              key: idJagKey,
              typ: idp.assertionTyp,
              claims: {
                iss: currentIssuerUrl,
                sub: `subject_${clientId}`,
                aud: audience,
                // draft §5: the id the RESOURCE authorization server knows this
                // client by, which the IdP holds out of band.
                client_id: idp.resourceClientIds?.[clientId] ?? clientId,
                jti: `jti_${randomUUID()}`,
                iat: issuedAtSeconds,
                exp: issuedAtSeconds + idJagLifetimeSeconds,
                email: `${options.defaultUsername ?? "alice"}@executor.test`,
                ...(resourceParam ? { resource: resourceParam } : {}),
                ...(grantedScope ? { scope: grantedScope } : {}),
              },
            });
            return jsonResponse(
              200,
              {
                issued_token_type: ID_JAG_TOKEN_TYPE_URN,
                access_token: assertion,
                token_type: "N_A",
                expires_in: idJagLifetimeSeconds,
                ...(grantedScope ? { scope: grantedScope } : {}),
              },
              { "cache-control": "no-store", pragma: "no-cache" },
            );
          }

          // RFC 7523 jwt-bearer redemption of an ID-JAG (draft §4.4).
          if (grantType === JWT_BEARER_GRANT_TYPE_URN) {
            const resourceServer = options.enterpriseResourceServer;
            if (!resourceServer) {
              return oauthError(
                400,
                "unsupported_grant_type",
                "This authorization server does not accept identity assertion grants",
              );
            }
            const assertion = params.get("assertion");
            if (!assertion) {
              return oauthError(400, "invalid_request", "assertion is required");
            }
            const jwks = yield* fetchTrustedIdpJwks(resourceServer.trustedIdpIssuer);
            if (Option.isNone(jwks)) {
              return oauthError(
                400,
                "invalid_grant",
                `The JWKS of ${resourceServer.trustedIdpIssuer} could not be retrieved`,
              );
            }
            const verified = verifyIdJag({
              assertion,
              trustedIssuer: resourceServer.trustedIdpIssuer,
              jwks: jwks.value,
              audience: currentIssuerUrl,
              authenticatedClientId: clientId,
            });
            if (!verified.ok) {
              return oauthError(400, "invalid_grant", verified.detail);
            }
            const assertedScopes = verified.claims.scope?.split(/\s+/).filter(Boolean) ?? [];
            const grantable = resourceServer.grantableScopes;
            const granted =
              grantable === undefined
                ? assertedScopes
                : assertedScopes.filter((scope) => grantable.includes(scope));
            const accessToken = `at_${randomUUID()}`;
            yield* Ref.update(issuedAccessTokens, (tokens) => new Set([...tokens, accessToken]));
            // draft §4.4.3: no refresh token. The ID-JAG chain IS the renewal
            // path, and issuing one here would let a client skip the IdP's
            // policy evaluation on every subsequent renewal.
            return jsonResponse(
              200,
              {
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: tokenExpiresInSeconds,
                ...(granted.length > 0 ? { scope: granted.join(" ") } : {}),
              },
              { "cache-control": "no-store" },
            );
          }

          return oauthError(400, "unsupported_grant_type", "Unsupported grant type");
        }

        if (requestUrl.pathname === "/mcp") {
          const authorization = headers.authorization;
          const token = authorization?.replace(/^Bearer\s+/i, "");
          const valid = token
            ? yield* Ref.get(issuedAccessTokens).pipe(Effect.map((tokens) => tokens.has(token)))
            : false;
          if (!valid) {
            return jsonResponse(
              401,
              { error: "invalid_token" },
              {
                "www-authenticate": `Bearer resource_metadata="${currentIssuerUrl}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
              },
            );
          }
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          });
        }

        return jsonResponse(404, { error: "not_found" });
      }),
    );

    issuerUrl = server.baseUrl;
    const accessTokenSet = Ref.get(issuedAccessTokens);

    return {
      issuerUrl,
      authorizationEndpoint: `${issuerUrl}/authorize`,
      tokenEndpoint: `${issuerUrl}/token`,
      registrationEndpoint: `${issuerUrl}/register`,
      protectedResourceMetadataUrl: `${issuerUrl}/.well-known/oauth-protected-resource`,
      resourceUrl: issuerUrl,
      mcpResourceUrl: `${issuerUrl}/mcp`,
      completeAuthorizationCodeFlow: completeAuthorizationCodeFlow({
        username: options.defaultUsername ?? "alice",
        password: options.defaultPassword ?? "password",
      }),
      completeAuthorizationCodeTokenFlow: completeAuthorizationCodeTokenFlow({
        username: options.defaultUsername ?? "alice",
        password: options.defaultPassword ?? "password",
        clientId: defaultClientId,
        clientSecret: defaultClientSecret,
        authorizationEndpoint: `${issuerUrl}/authorize`,
        tokenEndpoint: `${issuerUrl}/token`,
      }),
      requests: Ref.get(requests),
      clearRequests: Ref.set(requests, []),
      issuedAccessTokens: accessTokenSet.pipe(Effect.map((tokens) => [...tokens])),
      acceptsAccessToken: (token) => accessTokenSet.pipe(Effect.map((tokens) => tokens.has(token))),
      revokeAccessToken: (token) =>
        Ref.update(issuedAccessTokens, (tokens) => {
          const next = new Set(tokens);
          next.delete(token);
          return next;
        }),
      revokeRefreshTokensFor: (clientId) =>
        Effect.sync(() => {
          const doomed = [...refreshTokens.entries()].filter(
            ([, record]) => record.clientId === clientId,
          );
          for (const [token] of doomed) refreshTokens.delete(token);
          return doomed.length;
        }),
      setTokenExchangeDenial: (denial) => Ref.set(tokenExchangeDenial, denial),
      acceptsAuthorizationHeader: (authorization) => {
        const token = authorization?.replace(/^Bearer\s+/i, "");
        return token
          ? accessTokenSet.pipe(Effect.map((tokens) => tokens.has(token)))
          : Effect.succeed(false);
      },
    };
  });

export class OAuthTestServer extends Context.Service<OAuthTestServer, OAuthTestServerShape>()(
  "@executor-js/sdk/testing/OAuthTestServer",
) {
  static readonly layer = (options?: OAuthTestServerOptions) =>
    Layer.effect(OAuthTestServer, serveOAuthTestServer(options));
}
