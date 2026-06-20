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

        if (
          requestUrl.pathname === "/.well-known/oauth-authorization-server" ||
          requestUrl.pathname === "/.well-known/openid-configuration"
        ) {
          return jsonResponse(200, {
            issuer: currentIssuerUrl,
            authorization_endpoint: `${currentIssuerUrl}/authorize`,
            token_endpoint: `${currentIssuerUrl}/token`,
            registration_endpoint: `${currentIssuerUrl}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: [
              "none",
              "client_secret_post",
              "client_secret_basic",
            ],
            scopes_supported: scopes,
          });
        }

        if (requestUrl.pathname === "/register" && request.method === "POST") {
          const json = parseJsonObject(body);
          if (!json) {
            return oauthError(400, "invalid_client_metadata", "Expected JSON body");
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
            const refreshToken = `rt_${randomUUID()}`;
            yield* Ref.update(issuedAccessTokens, (tokens) => new Set([...tokens, accessToken]));
            refreshTokens.set(refreshToken, {
              clientId,
              username: record.username,
              scope: record.scope,
              resource: record.resource,
            });
            const scope = tokenResponseScope(record.scope);
            return jsonResponse(
              200,
              {
                access_token: accessToken,
                refresh_token: refreshToken,
                token_type: "Bearer",
                expires_in: 3600,
                ...(scope ? { scope } : {}),
              },
              { "cache-control": "no-store" },
            );
          }

          if (grantType === "refresh_token") {
            const refreshToken = params.get("refresh_token");
            const record = refreshToken ? refreshTokens.get(refreshToken) : undefined;
            if (!supportRefresh || !refreshToken || !record || record.clientId !== clientId) {
              return oauthError(400, "invalid_grant", "Unknown refresh token");
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
                expires_in: 3600,
                ...(scope ? { scope } : {}),
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
                expires_in: 3600,
                scope: params.get("scope") ?? scopes.join(" "),
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
