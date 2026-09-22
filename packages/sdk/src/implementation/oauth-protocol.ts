/** OAuth wire protocol. Effect owns transport and cancellation; oauth4webapi validates responses. */
import { parseDestination } from "@executor-js/utils/url-policy";
import { Effect, Encoding, Schema } from "effect";
import { captureTelemetry } from "@executor-js/telemetry";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as oauth from "oauth4webapi";
import {
  OAuthResource,
  OAuthServer,
  OAuthTokenServer,
  type OAuthConfidentialRegistration,
  OAuthRegistration,
  type OAuthOptions,
  type OAuthClientAuth,
} from "../contracts/oauth.ts";
import type { ProviderAuthMethod } from "../contracts/provider.ts";
import { bearerResourceMetadata } from "./oauth-challenge.ts";

/** Private, sanitized protocol failure. Never retain a response, request, or thrown library error. */
export class OAuthProtocolFailed extends Schema.TaggedError<OAuthProtocolFailed>()(
  "OAuthProtocolFailed",
  {
    reason: Schema.Literals(["request", "invalid_grant", "invalid_client", "invalid_response"]),
  },
) {}

const failure = (error: unknown) =>
  new OAuthProtocolFailed({
    reason:
      error instanceof oauth.ResponseBodyError && error.error === "invalid_grant"
        ? "invalid_grant"
        : error instanceof oauth.ResponseBodyError && error.error === "invalid_client"
          ? "invalid_client"
          : "request",
  });

/** Rehydrate mutable protocol arrays from the immutable storage contract. */
const metadata = (server: OAuthTokenServer): oauth.AuthorizationServer => ({
  issuer: server.issuer,
  ...(server.authorization_endpoint === undefined
    ? {}
    : { authorization_endpoint: server.authorization_endpoint }),
  token_endpoint: server.token_endpoint,
  ...(server.jwks_uri === undefined ? {} : { jwks_uri: server.jwks_uri }),
  ...(server.registration_endpoint === undefined
    ? {}
    : { registration_endpoint: server.registration_endpoint }),
  ...(server.authorization_response_iss_parameter_supported === undefined
    ? {}
    : {
        authorization_response_iss_parameter_supported:
          server.authorization_response_iss_parameter_supported,
      }),
  ...(server.code_challenge_methods_supported === undefined
    ? {}
    : { code_challenge_methods_supported: [...server.code_challenge_methods_supported] }),
  ...(server.token_endpoint_auth_methods_supported === undefined
    ? {}
    : { token_endpoint_auth_methods_supported: [...server.token_endpoint_auth_methods_supported] }),
});

const clientAuth = (client: OAuthRegistration) => {
  switch (client.token_endpoint_auth_method) {
    case "none":
      return oauth.None();
    case "client_secret_basic":
      return oauth.ClientSecretBasic(client.client_secret);
    case "client_secret_basic_raw":
      return ((_server, registered, _body, headers) => {
        headers.set(
          "authorization",
          `Basic ${Encoding.encodeBase64(new TextEncoder().encode(`${registered.client_id}:${client.client_secret}`))}`,
        );
      }) satisfies oauth.ClientAuth;
    case "client_secret_post":
      return oauth.ClientSecretPost(client.client_secret);
  }
};

/** Resolve protocol operations against one host-supplied Effect HTTP client. */
export const makeOAuthProtocol = (options: OAuthOptions) => {
  // This callback is the external library boundary, not an internal Promise implementation.
  const transport =
    (telemetry: Effect.Success<typeof captureTelemetry>) =>
    (url: string, init: oauth.CustomFetchOptions<string, BodyInit | undefined>) =>
      Effect.runPromiseWith(telemetry.context)(
        Effect.gen(function* () {
          // Enforce host policy on every request, including discovered endpoints and saved grants.
          const destination = parseDestination(url, options.urlPolicy);
          if (destination === undefined)
            return yield* new OAuthProtocolFailed({ reason: "request" });
          const request = yield* Effect.try({
            try: () =>
              HttpClientRequest.fromWeb(
                new Request(destination, {
                  method: init.method,
                  headers: init.headers,
                  ...(init.body === undefined ? {} : { body: init.body }),
                }),
              ),
            catch: failure,
          });
          const response = yield* options.httpClient.execute(request);
          const body = yield* response.arrayBuffer.pipe(Effect.withSpan("oauth.response.read"));
          return new Response(body, { status: response.status, headers: response.headers });
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(failure),
        ),
        init.signal === undefined ? {} : { signal: init.signal },
      );
  const requestOptions = (
    signal: AbortSignal,
    telemetry: Effect.Success<typeof captureTelemetry>,
  ) => ({ [oauth.customFetch]: transport(telemetry), [oauth.allowInsecureRequests]: true, signal });
  const request = <A>(run: (settings: ReturnType<typeof requestOptions>) => Promise<A>) =>
    Effect.gen(function* () {
      const telemetry = yield* captureTelemetry;
      return yield* Effect.tryPromise({
        try: (signal) => run(requestOptions(signal, telemetry)),
        catch: failure,
      });
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.withSpan("oauth.request"),
      Effect.mapError((error) =>
        error._tag === "TimeoutError" ? new OAuthProtocolFailed({ reason: "request" }) : error,
      ),
    );
  const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new OAuthProtocolFailed({ reason: "invalid_response" })),
    );

  const clientMethod = (server: OAuthTokenServer, configured?: OAuthClientAuth) => {
    const supported = server.token_endpoint_auth_methods_supported;
    const method =
      configured ??
      (supported?.includes("none")
        ? "none"
        : supported?.includes("client_secret_post") && !supported.includes("client_secret_basic")
          ? "client_secret_post"
          : "client_secret_basic");
    const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
    return supported !== undefined && !supported.includes(advertised)
      ? Effect.fail(new OAuthProtocolFailed({ reason: "invalid_response" }))
      : Effect.succeed(method);
  };

  const discoverIssuer = (issuer: URL) =>
    request(async (settings) => {
      const response = await oauth.discoveryRequest(issuer, { ...settings, algorithm: "oauth2" });
      if (response.status === 404)
        return oauth.processDiscoveryResponse(
          issuer,
          await oauth.discoveryRequest(issuer, { ...settings, algorithm: "oidc" }),
        );
      return oauth.processDiscoveryResponse(issuer, response);
    }).pipe(Effect.flatMap((server) => decode(OAuthTokenServer, server)));

  const secureUrl = (value: string) => {
    const url = parseDestination(value, options.urlPolicy);
    return url === undefined
      ? Effect.fail(new OAuthProtocolFailed({ reason: "invalid_response" }))
      : Effect.succeed(url);
  };

  const discoverResource = (endpoint: URL) =>
    Effect.gen(function* () {
      // Inspect only headers: a successful MCP GET may open an endless SSE stream.
      const advertised = yield* Effect.scoped(
        HttpClient.withScope(options.httpClient)
          .get(endpoint, {
            headers: { accept: "application/json, text/event-stream" },
          })
          .pipe(
            Effect.map((response) => bearerResourceMetadata(response.headers["www-authenticate"])),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          ),
      ).pipe(Effect.timeout("10 seconds"), Effect.mapError(failure));
      const metadataUrl = advertised === undefined ? undefined : yield* secureUrl(advertised);
      const document = yield* request(async (settings) => {
        let response =
          metadataUrl === undefined
            ? await oauth.resourceDiscoveryRequest(endpoint, settings)
            : await settings[oauth.customFetch](metadataUrl.href, {
                method: "GET",
                body: undefined,
                headers: { accept: "application/json" },
                redirect: "manual",
                signal: settings.signal,
              });
        if (metadataUrl === undefined && response.status === 404 && endpoint.pathname !== "/") {
          response = await settings[oauth.customFetch](
            new URL("/.well-known/oauth-protected-resource", endpoint).href,
            {
              method: "GET",
              body: undefined,
              headers: { accept: "application/json" },
              redirect: "manual",
              signal: settings.signal,
            },
          );
        }
        if (metadataUrl === undefined && response.status === 404) return undefined;
        if (response.status !== 200) throw new OAuthProtocolFailed({ reason: "request" });
        const document: unknown = await response.json();
        return document;
      });
      if (document === undefined) return undefined;
      const found = yield* decode(OAuthResource, document);
      const resource = yield* secureUrl(found.resource);
      // A resource can cover /mcp from the origin root, but cannot name a sibling
      // service or a different host. Preserve its exact advertised identifier.
      const prefix = resource.pathname.endsWith("/") ? resource.pathname : resource.pathname + "/";
      if (
        resource.origin !== endpoint.origin ||
        (resource.pathname !== endpoint.pathname && !endpoint.pathname.startsWith(prefix))
      ) {
        return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
      }
      return found;
    });

  return {
    discover: (method: Extract<ProviderAuthMethod, { type: "oauth2" }>) =>
      Effect.gen(function* () {
        const resolved = yield* Effect.gen(function* () {
          if (method.discover === undefined)
            return {
              server: yield* decode(OAuthTokenServer, {
                issuer: new URL(method.tokenUrl).origin,
                ...(method.authorizationUrl === undefined
                  ? {}
                  : { authorization_endpoint: method.authorizationUrl }),
                token_endpoint: method.tokenUrl,
              }),
              scopes: [...method.scopes],
              tokenEndpointAuthMethod: method.tokenEndpointAuthMethod ?? "none",
              ...(method.resource == null ? {} : { resource: method.resource }),
            };
          const resource = yield* secureUrl(method.discover);
          const found = yield* discoverResource(resource);
          const issuer = found === undefined ? resource.href : found.authorization_servers[0];
          if (issuer === undefined)
            return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
          const server = yield* discoverIssuer(yield* secureUrl(issuer));
          const scopes = new Set(method.scopes ?? found?.scopes_supported ?? []);
          if (
            method.grant !== "client_credentials" &&
            method.scopes === undefined &&
            server.scopes_supported?.includes("offline_access")
          )
            scopes.add("offline_access");
          const resourceIndicator =
            method.resource === undefined ? found?.resource : method.resource;
          return {
            server,
            scopes: [...scopes],
            tokenEndpointAuthMethod: yield* clientMethod(server, method.tokenEndpointAuthMethod),
            ...(resourceIndicator == null ? {} : { resource: resourceIndicator }),
          };
        });
        if (method.grant === "client_credentials")
          return { ...resolved, grant: "client_credentials" as const };
        return {
          ...resolved,
          grant: "authorization_code" as const,
          server: yield* decode(OAuthServer, resolved.server),
        };
      }).pipe(Effect.withSpan("oauth.discover")),
    register: (
      server: OAuthServer,
      redirectUri: string,
      scopes: readonly string[],
      configured?: OAuthClientAuth,
    ) =>
      Effect.gen(function* () {
        const method = yield* clientMethod(server, configured);
        const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
        const registered = yield* request(async (settings) =>
          oauth.processDynamicClientRegistrationResponse(
            await oauth.dynamicClientRegistrationRequest(
              metadata(server),
              {
                client_name: options.clientName,
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: advertised,
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
              },
              settings,
            ),
          ),
        );
        if (
          registered.token_endpoint_auth_method !== undefined &&
          registered.token_endpoint_auth_method !== advertised
        )
          return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
        return yield* decode(OAuthRegistration, {
          ...registered,
          token_endpoint_auth_method: method,
        });
      }).pipe(Effect.withSpan("oauth.register")),
    authorize: (input: {
      server: OAuthServer;
      client: OAuthRegistration;
      redirectUri: string;
      scopes: readonly string[];
      resource?: string;
    }) =>
      Effect.gen(function* () {
        const state = yield* Effect.sync(oauth.generateRandomState);
        const verifier = yield* Effect.sync(oauth.generateRandomCodeVerifier);
        const nonce = input.scopes.includes("openid")
          ? yield* Effect.sync(oauth.generateRandomNonce)
          : undefined;
        const challenge = yield* request(() => oauth.calculatePKCECodeChallenge(verifier));
        const url = new URL(input.server.authorization_endpoint);
        for (const [key, value] of Object.entries({
          response_type: "code",
          client_id: input.client.client_id,
          redirect_uri: input.redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }))
          url.searchParams.set(key, value);
        if (input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "));
        if (input.resource !== undefined) url.searchParams.set("resource", input.resource);
        if (nonce !== undefined) url.searchParams.set("nonce", nonce);
        return {
          state,
          verifier,
          authorizationUrl: url.href,
          ...(nonce === undefined ? {} : { nonce }),
        };
      }).pipe(Effect.withSpan("oauth.authorize")),
    exchange: (
      input: {
        server: OAuthServer;
        client: OAuthRegistration;
        redirectUri: string;
        state: string;
        verifier: string;
        resource?: string | undefined;
        nonce?: string | undefined;
      },
      callback: URL,
    ) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const parameters = oauth.validateAuthResponse(server, input.client, callback, input.state);
        const response = await oauth.authorizationCodeGrantRequest(
          server,
          input.client,
          clientAuth(input.client),
          parameters,
          input.redirectUri,
          input.verifier,
          {
            ...settings,
            ...(input.resource === undefined
              ? {}
              : { additionalParameters: { resource: input.resource } }),
          },
        );
        return oauth.processAuthorizationCodeResponse(
          server,
          input.client,
          response,
          input.nonce === undefined ? {} : { expectedNonce: input.nonce, requireIdToken: true },
        );
      }).pipe(Effect.withSpan("oauth.exchange")),
    clientCredentials: (input: {
      server: OAuthTokenServer;
      client: OAuthConfidentialRegistration;
      scopes: readonly string[];
      resource?: string | undefined;
    }) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const parameters = new URLSearchParams();
        if (input.scopes.length > 0) parameters.set("scope", input.scopes.join(" "));
        if (input.resource !== undefined) parameters.set("resource", input.resource);
        const response = await oauth.clientCredentialsGrantRequest(
          server,
          input.client,
          clientAuth(input.client),
          parameters,
          settings,
        );
        return oauth.processClientCredentialsResponse(server, input.client, response);
      }).pipe(Effect.withSpan("oauth.clientCredentials")),
    refresh: (input: {
      server: OAuthServer;
      client: OAuthRegistration;
      refreshToken: string;
      resource?: string | undefined;
    }) =>
      request(async (settings) => {
        const server = metadata(input.server);
        return oauth.processRefreshTokenResponse(
          server,
          input.client,
          await oauth.refreshTokenGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            input.refreshToken,
            {
              ...settings,
              ...(input.resource === undefined
                ? {}
                : { additionalParameters: { resource: input.resource } }),
            },
          ),
        );
      }).pipe(Effect.withSpan("oauth.refresh")),
  };
};
