import { Data, Duration, Effect, Exit, Option, Predicate, Schema, type Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  OAUTH2_PROVIDER_KEY,
  OAuthProviderStateSchema,
  assertSupportedOAuthEndpointUrl,
  type Executor,
} from "@executor-js/sdk";
import type { ConnectionId, ScopeId } from "@executor-js/sdk/shared";

import type { ConnectionIdentityResponse } from "../connections/api";

const OidcDiscoveryMetadata = Schema.Struct({
  issuer: Schema.optional(Schema.String),
  userinfo_endpoint: Schema.optional(Schema.String),
}).annotate({ identifier: "OidcDiscoveryMetadata" });

const UserInfoClaims = Schema.Struct({
  sub: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  email_verified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  preferred_username: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
}).annotate({ identifier: "OidcUserInfoClaims" });

const decodeProviderStateOption = Schema.decodeUnknownOption(OAuthProviderStateSchema);
const decodeDiscoveryMetadataJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OidcDiscoveryMetadata),
);
const decodeUserInfoJson = Schema.decodeUnknownEffect(Schema.fromJsonString(UserInfoClaims));

class ConnectionIdentityLookupError extends Data.TaggedError("ConnectionIdentityLookupError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const emptyIdentity = (
  status: ConnectionIdentityResponse["status"],
  message: string | null,
): ConnectionIdentityResponse => ({
  status,
  source: "unknown",
  subject: null,
  email: null,
  emailVerified: null,
  name: null,
  username: null,
  picture: null,
  message,
});

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const hasOidcIdentityScope = (oauthScope: string | null): boolean =>
  oauthScope
    ?.split(/\s+/)
    .some((scope) => scope === "openid" || scope === "profile" || scope === "email") ?? false;

const applyIdentityOverride = (
  identity: ConnectionIdentityResponse,
  override: {
    readonly displayName: string | null;
    readonly email: string | null;
    readonly avatarUrl: string | null;
  } | null,
): ConnectionIdentityResponse => {
  if (!override) return identity;
  const name = clean(override.displayName ?? undefined);
  const email = clean(override.email ?? undefined);
  const picture = clean(override.avatarUrl ?? undefined);
  if (!name && !email && !picture) return identity;
  const hasDetected =
    identity.status === "available" &&
    Boolean(identity.name || identity.email || identity.picture || identity.subject);
  return {
    ...identity,
    status: "available",
    source: hasDetected ? "mixed" : "manual",
    name: name ?? identity.name,
    email: email ?? identity.email,
    picture: picture ?? identity.picture,
    message: hasDetected ? identity.message : null,
  };
};

const oidcMetadataUrlFor = (issuer: string): Effect.Effect<string, ConnectionIdentityLookupError> =>
  Effect.try({
    try: () => {
      assertSupportedOAuthEndpointUrl(issuer, "OIDC issuer URL");
      const issuerUrl = new URL(issuer);
      const issuerOrigin = `${issuerUrl.protocol}//${issuerUrl.host}`;
      const issuerPath = issuerUrl.pathname.replace(/\/+$/, "");
      const metadataUrl =
        issuerPath && issuerPath !== "/"
          ? `${issuerOrigin}/.well-known/openid-configuration${issuerPath}`
          : `${issuerOrigin}/.well-known/openid-configuration`;
      assertSupportedOAuthEndpointUrl(metadataUrl, "OIDC metadata URL");
      return metadataUrl;
    },
    catch: (cause) =>
      new ConnectionIdentityLookupError({
        message: "OIDC issuer URL is not supported",
        cause,
      }),
  });

const executeText = (
  request: HttpClientRequest.HttpClientRequest,
  options: {
    readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
    readonly timeoutMs?: number;
  },
  message: string,
): Effect.Effect<
  { readonly status: number; readonly body: string },
  ConnectionIdentityLookupError
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            new ConnectionIdentityLookupError({
              message,
              cause: "timeout",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        Predicate.isTagged("ConnectionIdentityLookupError")(cause)
          ? cause
          : new ConnectionIdentityLookupError({ message, cause }),
      ),
    );
    const body = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new ConnectionIdentityLookupError({
            message: `${message}: response body could not be read`,
            status: response.status,
            cause,
          }),
      ),
    );
    return { status: response.status, body };
  }).pipe(Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer));

const fetchOidcMetadata = (
  issuer: string,
  options: {
    readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
    readonly timeoutMs?: number;
  },
): Effect.Effect<typeof OidcDiscoveryMetadata.Type, ConnectionIdentityLookupError> =>
  Effect.gen(function* () {
    const metadataUrl = yield* oidcMetadataUrlFor(issuer);
    const response = yield* executeText(
      HttpClientRequest.get(metadataUrl).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
      options,
      "Failed to fetch OIDC metadata",
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new ConnectionIdentityLookupError({
        message: `OIDC metadata returned status ${response.status}`,
        status: response.status,
      });
    }
    return yield* decodeDiscoveryMetadataJson(response.body).pipe(
      Effect.mapError(
        (cause) =>
          new ConnectionIdentityLookupError({
            message: "OIDC metadata is malformed",
            cause,
          }),
      ),
    );
  });

export const lookupOidcConnectionIdentity = (
  input: {
    readonly issuerUrl: string;
    readonly accessToken: string;
  },
  options: {
    readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
    readonly timeoutMs?: number;
  } = {},
): Effect.Effect<ConnectionIdentityResponse, never> =>
  Effect.gen(function* () {
    const metadata = yield* fetchOidcMetadata(input.issuerUrl, options).pipe(
      Effect.catchTag("ConnectionIdentityLookupError", () => Effect.succeed(null)),
    );
    const advertisedUserinfoEndpoint = metadata?.userinfo_endpoint;
    if (!advertisedUserinfoEndpoint) {
      return emptyIdentity("unavailable", "This connection does not advertise OIDC userinfo");
    }

    const userinfoEndpoint = yield* Effect.try({
      try: () => {
        assertSupportedOAuthEndpointUrl(advertisedUserinfoEndpoint, "OIDC userinfo URL");
        return advertisedUserinfoEndpoint;
      },
      catch: (cause) =>
        new ConnectionIdentityLookupError({
          message: "OIDC userinfo URL is not supported",
          cause,
        }),
    }).pipe(Effect.catchTag("ConnectionIdentityLookupError", () => Effect.succeed(null)));
    if (!userinfoEndpoint) return emptyIdentity("unavailable", "OIDC userinfo is unavailable");

    const response = yield* executeText(
      HttpClientRequest.get(userinfoEndpoint).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.setHeader("authorization", `Bearer ${input.accessToken}`),
      ),
      options,
      "Failed to fetch OIDC userinfo",
    ).pipe(
      Effect.catchTag("ConnectionIdentityLookupError", ({ message }) =>
        Effect.succeed({ status: 0, body: "", message } as const),
      ),
    );
    if ("message" in response) return emptyIdentity("error", response.message);
    if (response.status === 401) {
      return emptyIdentity("reauth_required", "OIDC userinfo rejected the access token");
    }
    if (response.status === 403) {
      return emptyIdentity("unavailable", "OIDC userinfo is not permitted by this token");
    }
    if (response.status < 200 || response.status >= 300) {
      return emptyIdentity("error", `OIDC userinfo returned status ${response.status}`);
    }

    const claims = yield* decodeUserInfoJson(response.body).pipe(
      Effect.catch(() => Effect.succeed(null as typeof UserInfoClaims.Type | null)),
    );
    if (!claims) return emptyIdentity("error", "OIDC userinfo response is malformed");

    return {
      status: "available",
      source: "detected",
      subject: clean(claims.sub),
      email: clean(claims.email),
      emailVerified: claims.email_verified ?? null,
      name: clean(claims.name),
      username: clean(claims.preferred_username),
      picture: clean(claims.picture),
      message: null,
    };
  });

export const readConnectionIdentity = (input: {
  readonly executor: Executor;
  readonly scopeId: ScopeId;
  readonly connectionId: ConnectionId;
}): Effect.Effect<ConnectionIdentityResponse, never> =>
  Effect.gen(function* () {
    const connectionExit = yield* Effect.exit(
      input.executor.connections.getAtScope(input.connectionId, input.scopeId),
    );
    if (Exit.isFailure(connectionExit)) {
      return emptyIdentity("error", "Could not read connection metadata");
    }
    const connection = connectionExit.value;
    if (!connection) return emptyIdentity("unavailable", "Connection was not found");
    const withOverride = (identity: ConnectionIdentityResponse) =>
      applyIdentityOverride(identity, connection.identityOverride);
    if (connection.provider !== OAUTH2_PROVIDER_KEY) {
      return withOverride(
        emptyIdentity("unavailable", "Only OAuth2 connections can expose account identity"),
      );
    }

    const providerState = Option.getOrNull(decodeProviderStateOption(connection.providerState));
    const issuerUrl =
      providerState && providerState.kind !== "client-credentials"
        ? (providerState.issuerUrl ?? null)
        : null;
    if (!issuerUrl) {
      return withOverride(
        emptyIdentity("unavailable", "Connection does not include an OIDC issuer"),
      );
    }
    if (!hasOidcIdentityScope(connection.oauthScope)) {
      return withOverride(
        emptyIdentity("unavailable", "Connection was not granted OIDC identity scopes"),
      );
    }

    const accessTokenExit = yield* Effect.exit(
      input.executor.connections.accessTokenAtScope(input.connectionId, input.scopeId),
    );
    if (Exit.isFailure(accessTokenExit)) {
      const error = Option.getOrNull(Exit.findErrorOption(accessTokenExit));
      if (error && Predicate.isTagged("ConnectionReauthRequiredError")(error)) {
        return withOverride(emptyIdentity("reauth_required", "Connection needs re-authentication"));
      }
      return withOverride(emptyIdentity("error", "Could not read the connection access token"));
    }

    const identity = yield* lookupOidcConnectionIdentity({
      issuerUrl,
      accessToken: accessTokenExit.value,
    });
    return withOverride(identity);
  });
