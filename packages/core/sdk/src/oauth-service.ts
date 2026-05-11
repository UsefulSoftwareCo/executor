// ---------------------------------------------------------------------------
// OAuth service implementation — the runtime behind `ctx.oauth`.
//
// Owns three flows, all on one codepath:
//
//   - probe(endpoint)            RFC 9728 + 8414 metadata lookup without
//                                 starting a flow. Used by onboarding UI
//                                 to decide between dynamic-DCR and
//                                 paste-your-credentials strategies.
//
//   - start({strategy, ...})      Persists an `oauth2_session` row.
//                                 * `dynamic-dcr`    runs discovery +
//                                                    DCR + PKCE, emits
//                                                    an authorization URL.
//                                 * `authorization-code`
//                                                    uses pre-configured
//                                                    client_id (secret)
//                                                    + endpoints + PKCE.
//                                 * `client-credentials`
//                                                    no user step —
//                                                    mints the Connection
//                                                    inline, returns
//                                                    authorizationUrl=null.
//
//   - complete({state, code})     Looks up the session, exchanges code
//                                 for tokens, creates the Connection via
//                                 `ctx.connections.create`, deletes the
//                                 session. Idempotent-ish in the sense
//                                 that a retried code past TTL fails
//                                 clean rather than draining the AS.
//
// The service also exposes a canonical `"oauth2"` `ConnectionProvider`
// for refresh. The provider reads `providerState.kind` to pick which
// token endpoint + client credentials to present; one handler covers
// every strategy because refresh semantics are strategy-independent.
// ---------------------------------------------------------------------------

import { Duration, Effect, Layer, Match, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { StorageFailure, TypedAdapter } from "@executor-js/storage-core";

import {
  ConnectionRefreshError,
  CreateConnectionInput,
  TokenMaterial,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
  type ConnectionRef,
} from "./connections";
import type { ConnectionProviderNotRegisteredError } from "./errors";
import type { CoreSchema } from "./core-schema";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { SetSecretInput, type SecretRef } from "./secrets";
import {
  OAUTH2_PROVIDER_KEY,
  OAUTH2_SESSION_TTL_MS,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthProviderState as OAuthProviderStateSchema,
  OAuthSessionNotFoundError,
  OAuthStartError,
  type OAuthAuthorizationCodeStrategy,
  type OAuthClientCredentialsStrategy,
  type OAuthCompleteInput,
  type OAuthCompleteResult,
  type OAuthDynamicDcrStrategy,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthProviderState,
  type OAuthService,
  type OAuthStartInput,
  type OAuthStartResult,
} from "./oauth";
import {
  beginDynamicAuthorization,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
} from "./oauth-discovery";
import {
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  type OAuth2Error,
  type OAuthEndpointUrlPolicy,
  refreshAccessToken,
} from "./oauth-helpers";
import type { ScopedDBAdapter } from "./scoped-adapter";

// ---------------------------------------------------------------------------
// Session payload — persisted under `oauth2_session.payload` as opaque
// JSON. Shape is strategy-specific; the discriminator matches
// `OAuthStrategy["kind"]` so completion picks the right exchange path.
// ---------------------------------------------------------------------------

const OAuthAuthorizationServerMetadataJson = Schema.Record(Schema.String, Schema.Unknown);
const OAuthClientInformationJson = Schema.Record(Schema.String, Schema.Unknown);

const DynamicDcrSessionPayload = Schema.Struct({
  kind: Schema.Literal("dynamic-dcr"),
  identityLabel: Schema.NullOr(Schema.String),
  codeVerifier: Schema.String,
  authorizationServerUrl: Schema.String,
  authorizationServerMetadataUrl: Schema.String,
  authorizationServerMetadata: OAuthAuthorizationServerMetadataJson,
  clientInformation: OAuthClientInformationJson,
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  scopes: Schema.Array(Schema.String),
  resource: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
});

const AuthorizationCodeSessionPayload = Schema.Struct({
  kind: Schema.Literal("authorization-code"),
  identityLabel: Schema.NullOr(Schema.String),
  codeVerifier: Schema.String,
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  issuerUrl: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  clientIdSecretId: Schema.String,
  clientIdSecretScopeId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  clientSecretSecretId: Schema.NullOr(Schema.String),
  clientSecretSecretScopeId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  scopes: Schema.Array(Schema.String),
  scopeSeparator: Schema.optional(Schema.String),
  clientAuth: Schema.Literals(["body", "basic"]),
});

/** `client-credentials` doesn't produce a session row — it mints the
 *  Connection inline during `start`. The shape is included here for
 *  completeness / future device-code use. */
const OAuthSessionPayload = Schema.Union([
  DynamicDcrSessionPayload,
  AuthorizationCodeSessionPayload,
]);
type OAuthSessionPayload = typeof OAuthSessionPayload.Type;

const decodeSessionPayload = Schema.decodeUnknownSync(OAuthSessionPayload);
const encodeSessionPayload = Schema.encodeSync(OAuthSessionPayload);

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJsonOption = Schema.decodeUnknownOption(UnknownFromJsonString);

const decodeProviderStateSync = Schema.decodeUnknownSync(OAuthProviderStateSchema);
const encodeProviderStateSync = Schema.encodeSync(OAuthProviderStateSchema);

const coerceJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return decodeUnknownJsonOption(value).pipe(Option.getOrElse(() => value));
};

const decodeProviderState = (value: unknown): OAuthProviderState =>
  decodeProviderStateSync(coerceJson(value));

// ---------------------------------------------------------------------------
// Service dependencies — the executor wires these up when it constructs
// the service. Every dep is a narrow surface so the service stays
// testable: point to an in-memory adapter + a secrets stub and every
// code path is exercisable.
// ---------------------------------------------------------------------------

export interface OAuthServiceDeps {
  /** Typed core-schema adapter. Already scope-wrapped upstream so reads
   *  fall through the scope stack; writes stamp the scope the caller
   *  named (`tokenScope` on start input). */
  readonly adapter: TypedAdapter<CoreSchema>;
  /** Scoped adapter for opening transactions — the typed one doesn't
   *  expose `.transaction` directly. */
  readonly rawAdapter: ScopedDBAdapter;
  /** Resolves client-id / client-secret refs at start + refresh time.
   *  A `null` return means "secret row is gone" and aborts the flow. */
  readonly secretsGet: (id: string) => Effect.Effect<string | null, StorageFailure>;
  readonly secretsGetResolved?: (
    id: string,
  ) => Effect.Effect<
    { readonly value: string; readonly scopeId: string | null } | null,
    StorageFailure
  >;
  readonly secretsGetAtScope?: (
    id: string,
    scope: string,
  ) => Effect.Effect<string | null, StorageFailure>;
  readonly secretsSet: (input: SetSecretInput) => Effect.Effect<SecretRef, StorageFailure>;
  /** Mints the Connection row + backing secret rows. Called from
   *  `complete` (and from `start` for `client-credentials`). */
  readonly connectionsCreate: (
    input: CreateConnectionInput,
  ) => Effect.Effect<ConnectionRef, ConnectionProviderNotRegisteredError | StorageFailure>;
  /** Random session id generator. Tests override to make outputs
   *  deterministic. */
  readonly newSessionId?: () => string;
  /** `Date.now()` substitute — tests override to drive TTL behavior. */
  readonly now?: () => number;
  /** Outbound HTTP client used for OAuth metadata/DCR probes. */
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
}

const defaultSessionId = (): string => {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `oauth2_session_${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `oauth2_session_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )}`;
};

const secretIdPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "oauth";

const oauthSecretId = (
  connectionId: string,
  suffix: "access-token" | "refresh-token" | "client-secret",
): string => {
  const base = secretIdPart(connectionId);
  const readable = base.length <= 48 ? base : base.slice(0, 40);
  return `oauth2-${readable}-${suffix}`;
};

const scopedSessionId = (scopeId: string, sessionId: string): string =>
  `${sessionId}_${secretIdPart(scopeId).slice(0, 24)}`;

const terminalRefreshErrors = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export const makeOAuth2Service = (
  deps: OAuthServiceDeps,
): { readonly service: OAuthService; readonly connectionProvider: ConnectionProvider } => {
  const now = deps.now ?? (() => Date.now());
  const newSessionId = deps.newSessionId ?? defaultSessionId;
  const httpClientLayer = deps.httpClientLayer;
  const endpointUrlPolicy = deps.endpointUrlPolicy;
  const secretsGetResolved =
    deps.secretsGetResolved ??
    ((id: string) =>
      deps
        .secretsGet(id)
        .pipe(Effect.map((value) => (value === null ? null : { value, scopeId: null }))));
  const getSecretFromRecordedScope = (params: {
    readonly secretId: string;
    readonly scopeId: string | null;
  }) =>
    params.scopeId && deps.secretsGetAtScope
      ? deps.secretsGetAtScope(params.secretId, params.scopeId)
      : deps.secretsGet(params.secretId);

  // -------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------
  const probe = (input: OAuthProbeInput): Effect.Effect<OAuthProbeResult, OAuthProbeError> =>
    Effect.gen(function* () {
      const resource = yield* discoverProtectedResourceMetadata(input.endpoint, {
        httpClientLayer,
        resourceHeaders: input.headers,
        resourceQueryParams: input.queryParams,
      }).pipe(
        Effect.catchTag("OAuthDiscoveryError", ({ message }) =>
          Effect.fail(
            new OAuthProbeError({
              message: `Protected resource metadata probe failed: ${message}`,
            }),
          ),
        ),
      );

      const authorizationServerUrl = yield* (() => {
        const fromResource = resource?.metadata.authorization_servers?.[0];
        if (fromResource) return Effect.succeed(fromResource);
        return Effect.try({
          try: () => {
            const u = new URL(input.endpoint);
            return `${u.protocol}//${u.host}`;
          },
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
      })();

      const authServer = authorizationServerUrl
        ? yield* discoverAuthorizationServerMetadata(authorizationServerUrl, {
            httpClientLayer,
          }).pipe(Effect.catchTag("OAuthDiscoveryError", () => Effect.succeed(null)))
        : null;

      // Dynamic registration is only viable when the AS advertises a
      // registration_endpoint AND a token_endpoint_auth_method we can use
      // (`none`, `client_secret_post`, or `client_secret_basic`). If the AS
      // doesn't list any methods we assume `none` is acceptable per OAuth
      // 2.1 §2.4 (server's choice).
      const advertisedAuthMethods =
        authServer?.metadata.token_endpoint_auth_methods_supported ?? [];
      const hasNegotiableAuthMethod =
        advertisedAuthMethods.length === 0 ||
        advertisedAuthMethods.some(
          (m) => m === "none" || m === "client_secret_post" || m === "client_secret_basic",
        );
      const supportsDynamicRegistration = !!(
        authServer?.metadata.registration_endpoint && hasNegotiableAuthMethod
      );

      // Bearer challenge probe — POST the endpoint unauth, look for
      // 401 + WWW-Authenticate: Bearer. Harmless against non-MCP
      // endpoints (Railway/GraphQL endpoints respond 200 or 400 with
      // protocol-specific bodies that we simply read as "not a bearer
      // challenge").
      const isBearerChallengeEndpoint = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const probeUrl = new URL(input.endpoint);
        for (const [key, value] of Object.entries(input.queryParams ?? {})) {
          probeUrl.searchParams.set(key, value);
        }
        let request = HttpClientRequest.post(probeUrl.toString()).pipe(
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "executor-probe", version: "0" },
            },
          }),
        );
        for (const [name, value] of Object.entries(input.headers ?? {})) {
          request = HttpClientRequest.setHeader(request, name, value);
        }
        const response = yield* client.execute(request).pipe(Effect.timeout(Duration.seconds(6)));
        if (response.status !== 401) return false;
        const wwwAuth =
          response.headers["www-authenticate"] ?? response.headers["WWW-Authenticate"];
        return !!wwwAuth && /^\s*bearer\b/i.test(wwwAuth);
      }).pipe(
        Effect.provide(httpClientLayer ?? FetchHttpClient.layer),
        Effect.catch(() => Effect.succeed(false)),
      );

      return {
        resourceMetadata: (resource?.metadata as Record<string, unknown> | undefined) ?? null,
        resourceMetadataUrl: resource?.metadataUrl ?? null,
        authorizationServerMetadata:
          (authServer?.metadata as Record<string, unknown> | undefined) ?? null,
        authorizationServerMetadataUrl: authServer?.metadataUrl ?? null,
        authorizationServerUrl: authorizationServerUrl ?? null,
        supportsDynamicRegistration,
        isBearerChallengeEndpoint,
      };
    });

  // -------------------------------------------------------------------
  // start — branches on strategy.kind
  // -------------------------------------------------------------------
  const startDynamicDcr = (
    input: OAuthStartInput,
    strategy: OAuthDynamicDcrStrategy,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const started = yield* beginDynamicAuthorization(
        {
          endpoint: input.endpoint,
          redirectUrl: input.redirectUrl,
          state: "",
          scopes: strategy.scopes,
        },
        {
          httpClientLayer,
          resourceHeaders: input.headers,
          resourceQueryParams: input.queryParams,
          endpointUrlPolicy,
        },
      ).pipe(
        Effect.catchTag("OAuthDiscoveryError", ({ message, error, errorDescription }) =>
          Effect.fail(
            new OAuthStartError({
              message: `Dynamic authorization setup failed: ${message}`,
              error,
              errorDescription,
            }),
          ),
        ),
      );

      const sessionId = scopedSessionId(input.tokenScope, newSessionId());

      // beginDynamicAuthorization returns an authorizationUrl already
      // signed with whatever `state` we passed. We need the session id
      // to be the state parameter so completion can look up the row.
      // Re-build the URL with the corrected state — cheap, one SHA-256
      // for the PKCE challenge, no network calls.
      const codeChallenge = yield* Effect.promise(() =>
        createPkceCodeChallenge(started.codeVerifier),
      );
      const authorizationUrl = buildAuthorizationUrl({
        authorizationUrl: started.state.authorizationServerMetadata.authorization_endpoint,
        clientId: started.state.clientInformation.client_id,
        redirectUrl: input.redirectUrl,
        scopes: started.state.scopes,
        state: sessionId,
        codeChallenge,
        resource: started.state.resource,
        endpointUrlPolicy,
      });

      const payload: OAuthSessionPayload = {
        kind: "dynamic-dcr",
        identityLabel: input.identityLabel ?? null,
        codeVerifier: started.codeVerifier,
        authorizationServerUrl: started.state.authorizationServerUrl,
        authorizationServerMetadataUrl: started.state.authorizationServerMetadataUrl,
        authorizationServerMetadata: started.state.authorizationServerMetadata as Record<
          string,
          unknown
        >,
        clientInformation: (() => {
          const value: unknown = started.state.clientInformation;
          return value as Record<string, unknown>;
        })(),
        resourceMetadataUrl: started.state.resourceMetadataUrl,
        resourceMetadata:
          (started.state.resourceMetadata as Record<string, unknown> | null) ?? null,
        scopes: [...started.state.scopes],
        resource: started.state.resource,
      };

      yield* writeSession({
        sessionId,
        input,
        payload,
        strategyKind: "dynamic-dcr",
      });

      return {
        sessionId,
        authorizationUrl,
        completedConnection: null,
      };
    });

  const startAuthorizationCode = (
    input: OAuthStartInput,
    strategy: OAuthAuthorizationCodeStrategy,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const clientIdRef = yield* secretsGetResolved(strategy.clientIdSecretId).pipe(
        Effect.mapError(
          (err) =>
            // Storage failure propagates; null returns aren't errors — the
            // branch below handles them.
            err,
        ),
      );
      if (clientIdRef === null) {
        return yield* new OAuthStartError({
          message: `client_id secret "${strategy.clientIdSecretId}" not found`,
        });
      }

      const sessionId = scopedSessionId(input.tokenScope, newSessionId());
      const codeVerifier = createPkceCodeVerifier();
      const codeChallenge = yield* Effect.promise(() => createPkceCodeChallenge(codeVerifier));

      const authorizationUrl = buildAuthorizationUrl({
        authorizationUrl: strategy.authorizationEndpoint,
        clientId: clientIdRef.value,
        redirectUrl: input.redirectUrl,
        scopes: strategy.scopes,
        state: sessionId,
        codeChallenge,
        scopeSeparator: strategy.scopeSeparator,
        extraParams: strategy.extraAuthorizationParams,
        endpointUrlPolicy,
      });

      const payload: OAuthSessionPayload = {
        kind: "authorization-code",
        identityLabel: input.identityLabel ?? null,
        codeVerifier,
        authorizationEndpoint: strategy.authorizationEndpoint,
        tokenEndpoint: strategy.tokenEndpoint,
        issuerUrl: strategy.issuerUrl ?? new URL(strategy.authorizationEndpoint).origin,
        clientIdSecretId: strategy.clientIdSecretId,
        clientIdSecretScopeId: clientIdRef.scopeId,
        clientSecretSecretId: strategy.clientSecretSecretId ?? null,
        clientSecretSecretScopeId: strategy.clientSecretSecretId
          ? ((yield* secretsGetResolved(strategy.clientSecretSecretId))?.scopeId ?? null)
          : null,
        scopes: [...strategy.scopes],
        scopeSeparator: strategy.scopeSeparator,
        clientAuth: strategy.clientAuth ?? "body",
      };

      yield* writeSession({
        sessionId,
        input,
        payload,
        strategyKind: "authorization-code",
      });

      return {
        sessionId,
        authorizationUrl,
        completedConnection: null,
      };
    });

  const startClientCredentials = (
    input: OAuthStartInput,
    strategy: OAuthClientCredentialsStrategy,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const clientIdRef = yield* secretsGetResolved(strategy.clientIdSecretId);
      const clientSecretRef = yield* secretsGetResolved(strategy.clientSecretSecretId);
      if (clientIdRef === null || clientSecretRef === null) {
        return yield* new OAuthStartError({
          message: "client_id / client_secret secret not found",
        });
      }

      const tokens = yield* exchangeClientCredentials({
        tokenUrl: strategy.tokenEndpoint,
        clientId: clientIdRef.value,
        clientSecret: clientSecretRef.value,
        scopes: strategy.scopes,
        scopeSeparator: strategy.scopeSeparator,
        clientAuth: strategy.clientAuth ?? "body",
        endpointUrlPolicy,
      }).pipe(
        Effect.mapError(
          ({ message }: OAuth2Error) =>
            new OAuthStartError({
              message: `Client credentials exchange failed: ${message}`,
            }),
        ),
      );

      const expiresAt =
        typeof tokens.expires_in === "number" ? now() + tokens.expires_in * 1000 : null;

      const providerState: OAuthProviderState = {
        kind: "client-credentials",
        tokenEndpoint: strategy.tokenEndpoint,
        clientIdSecretId: strategy.clientIdSecretId,
        clientIdSecretScopeId: clientIdRef.scopeId,
        clientSecretSecretId: strategy.clientSecretSecretId,
        clientSecretSecretScopeId: clientSecretRef.scopeId,
        scopes: [...(strategy.scopes ?? [])],
        scopeSeparator: strategy.scopeSeparator,
        clientAuth: strategy.clientAuth ?? "body",
        scope: tokens.scope ?? null,
      };

      yield* deps
        .connectionsCreate(
          new CreateConnectionInput({
            id: ConnectionId.make(input.connectionId),
            scope: ScopeId.make(input.tokenScope),
            provider: OAUTH2_PROVIDER_KEY,
            identityLabel: input.identityLabel ?? safeHostname(input.endpoint),
            accessToken: new TokenMaterial({
              secretId: SecretId.make(oauthSecretId(input.connectionId, "access-token")),
              name: "OAuth Access Token",
              value: tokens.access_token,
            }),
            refreshToken: null,
            expiresAt,
            oauthScope: tokens.scope ?? null,
            providerState: encodeProviderStateSync(providerState) as Record<string, unknown>,
          }),
        )
        .pipe(
          Effect.catchTags({
            ConnectionProviderNotRegisteredError: () =>
              Effect.fail(
                new OAuthStartError({
                  message: "Failed to mint connection: ConnectionProviderNotRegisteredError",
                }),
              ),
            StorageError: ({ message }) =>
              Effect.fail(
                new OAuthStartError({
                  message: `Failed to mint connection: ${message}`,
                }),
              ),
            UniqueViolationError: () =>
              Effect.fail(
                new OAuthStartError({
                  message: "Failed to mint connection: UniqueViolationError",
                }),
              ),
          }),
        );

      return {
        sessionId: "",
        authorizationUrl: null,
        completedConnection: { connectionId: input.connectionId },
      };
    });

  const start = (
    input: OAuthStartInput,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Match.value(input.strategy).pipe(
      Match.when({ kind: "dynamic-dcr" }, (strategy) => startDynamicDcr(input, strategy)),
      Match.when({ kind: "authorization-code" }, (strategy) =>
        startAuthorizationCode(input, strategy),
      ),
      Match.when({ kind: "client-credentials" }, (strategy) =>
        startClientCredentials(input, strategy),
      ),
      Match.exhaustive,
    );

  const writeSession = (args: {
    sessionId: string;
    input: OAuthStartInput;
    payload: OAuthSessionPayload;
    strategyKind: string;
  }): Effect.Effect<void, StorageFailure> =>
    deps.adapter
      .create({
        model: "oauth2_session",
        data: {
          id: args.sessionId,
          scope_id: args.input.tokenScope,
          plugin_id: args.input.pluginId,
          strategy: args.strategyKind,
          connection_id: args.input.connectionId,
          token_scope: args.input.tokenScope,
          redirect_url: args.input.redirectUrl,
          payload: encodeSessionPayload(args.payload) as Record<string, unknown>,
          expires_at: now() + OAUTH2_SESSION_TTL_MS,
          created_at: new Date(),
        },
        forceAllowId: true,
      })
      .pipe(Effect.asVoid);

  // -------------------------------------------------------------------
  // complete — exchange the code, mint the Connection, delete the session
  // -------------------------------------------------------------------
  const complete = (
    input: OAuthCompleteInput,
  ): Effect.Effect<
    OAuthCompleteResult,
    OAuthCompleteError | OAuthSessionNotFoundError | StorageFailure
  > =>
    Effect.gen(function* () {
      const row = yield* deps.adapter.findOne({
        model: "oauth2_session",
        where: [{ field: "id", value: input.state }],
      });
      if (!row) {
        return yield* new OAuthSessionNotFoundError({ sessionId: input.state });
      }
      if (input.tokenScope !== undefined && row.token_scope !== input.tokenScope) {
        return yield* new OAuthSessionNotFoundError({ sessionId: input.state });
      }

      const deleteSession = deps.adapter.delete({
        model: "oauth2_session",
        where: [
          { field: "id", value: input.state },
          { field: "scope_id", value: row.scope_id },
        ],
      });

      if (input.error) {
        yield* deleteSession;
        return yield* new OAuthCompleteError({
          message: `Authorization server returned error: ${input.error}`,
          code: input.error,
        });
      }
      if (!input.code) {
        yield* deleteSession;
        return yield* new OAuthCompleteError({
          message: "Missing authorization code",
        });
      }
      const expiresAt = Number(row.expires_at as number | bigint);
      if (expiresAt <= now()) {
        yield* deleteSession;
        return yield* new OAuthCompleteError({
          message: "OAuth session expired",
        });
      }

      const payload = decodeSessionPayload(coerceJson(row.payload));
      const endpoint = ""; // not stored on the row — the payload's own
      // endpoint fields drive exchange; we just need
      // a display string for the identity label.
      const connectionId = row.connection_id;
      const tokenScope = row.token_scope;
      const redirectUrl = row.redirect_url;

      // Dispatch to the strategy-specific exchange.
      const inputCode = input.code;
      const exchangeResult = yield* Match.value(payload)
        .pipe(
          Match.when({ kind: "dynamic-dcr" }, (p) => exchangeDynamicDcr(p, inputCode, redirectUrl)),
          Match.when({ kind: "authorization-code" }, (p) =>
            exchangeAuthorizationCodeStrategy(p, inputCode, redirectUrl),
          ),
          Match.exhaustive,
        )
        .pipe(Effect.tapError(() => deleteSession));

      const connectionExpiresAt =
        typeof exchangeResult.tokens.expires_in === "number"
          ? now() + exchangeResult.tokens.expires_in * 1000
          : null;

      const dynamicClientSecretSecretId = yield* (() => {
        if (payload.kind !== "dynamic-dcr") return Effect.succeed(null);
        const clientSecret = payload.clientInformation.client_secret;
        if (typeof clientSecret !== "string" || clientSecret.length === 0) {
          return Effect.succeed(null);
        }
        const secretId = oauthSecretId(connectionId, "client-secret");
        return deps
          .secretsSet(
            new SetSecretInput({
              id: SecretId.make(secretId),
              scope: ScopeId.make(tokenScope),
              name: "OAuth Client Secret",
              value: clientSecret,
            }),
          )
          .pipe(
            Effect.as(secretId),
            Effect.catchTags({
              StorageError: ({ message }) =>
                Effect.fail(
                  new OAuthCompleteError({
                    message: `Failed to persist DCR client_secret: ${message}`,
                  }),
                ),
              UniqueViolationError: () =>
                Effect.fail(
                  new OAuthCompleteError({
                    message: "Failed to persist DCR client_secret: UniqueViolationError",
                  }),
                ),
            }),
          );
      })();

      const providerState: OAuthProviderState =
        payload.kind === "dynamic-dcr"
          ? {
              kind: "dynamic-dcr",
              tokenEndpoint: (
                payload.authorizationServerMetadata as {
                  token_endpoint: string;
                }
              ).token_endpoint,
              issuerUrl:
                (payload.authorizationServerMetadata as { issuer?: string }).issuer ?? null,
              authorizationServerUrl: payload.authorizationServerUrl,
              authorizationServerMetadataUrl: payload.authorizationServerMetadataUrl,
              idTokenSigningAlgValuesSupported: (
                payload.authorizationServerMetadata as {
                  id_token_signing_alg_values_supported?: string[];
                }
              ).id_token_signing_alg_values_supported,
              clientId: (payload.clientInformation as { client_id: string }).client_id,
              clientSecretSecretId: dynamicClientSecretSecretId,
              clientAuth:
                (payload.clientInformation as { token_endpoint_auth_method?: string })
                  .token_endpoint_auth_method === "client_secret_basic"
                  ? "basic"
                  : "body",
              clientSecretSecretScopeId: dynamicClientSecretSecretId ? tokenScope : null,
              scopes: [...payload.scopes],
              scope: exchangeResult.tokens.scope ?? null,
              resource: payload.resource,
            }
          : {
              kind: "authorization-code",
              tokenEndpoint: payload.tokenEndpoint,
              issuerUrl: payload.issuerUrl,
              clientIdSecretId: payload.clientIdSecretId,
              clientIdSecretScopeId: payload.clientIdSecretScopeId,
              clientSecretSecretId: payload.clientSecretSecretId,
              clientSecretSecretScopeId: payload.clientSecretSecretScopeId,
              clientAuth: payload.clientAuth,
              scopes: [...payload.scopes],
              scopeSeparator: payload.scopeSeparator,
              scope: exchangeResult.tokens.scope ?? null,
            };

      yield* deps
        .connectionsCreate(
          new CreateConnectionInput({
            id: ConnectionId.make(connectionId),
            scope: ScopeId.make(tokenScope),
            provider: OAUTH2_PROVIDER_KEY,
            identityLabel: safeHostname(
              payload.identityLabel ?? exchangeResult.endpointForDisplay ?? endpoint,
            ),
            accessToken: new TokenMaterial({
              secretId: SecretId.make(oauthSecretId(connectionId, "access-token")),
              name: "OAuth Access Token",
              value: exchangeResult.tokens.access_token,
            }),
            refreshToken: exchangeResult.tokens.refresh_token
              ? new TokenMaterial({
                  secretId: SecretId.make(oauthSecretId(connectionId, "refresh-token")),
                  name: "OAuth Refresh Token",
                  value: exchangeResult.tokens.refresh_token,
                })
              : null,
            expiresAt: connectionExpiresAt,
            oauthScope: exchangeResult.tokens.scope ?? null,
            providerState: encodeProviderStateSync(providerState) as Record<string, unknown>,
          }),
        )
        .pipe(
          Effect.catchTags({
            ConnectionProviderNotRegisteredError: () =>
              Effect.fail(
                new OAuthCompleteError({
                  message: "Failed to mint connection: ConnectionProviderNotRegisteredError",
                }),
              ),
            StorageError: ({ message }) =>
              Effect.fail(
                new OAuthCompleteError({
                  message: `Failed to mint connection: ${message}`,
                }),
              ),
            UniqueViolationError: () =>
              Effect.fail(
                new OAuthCompleteError({
                  message: "Failed to mint connection: UniqueViolationError",
                }),
              ),
          }),
        );

      yield* deleteSession;

      return {
        connectionId,
        expiresAt: connectionExpiresAt,
        scope: exchangeResult.tokens.scope ?? null,
      };
    });

  interface ExchangeResult {
    readonly tokens: {
      readonly access_token: string;
      readonly refresh_token?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly token_type?: string;
    };
    readonly endpointForDisplay: string | null;
  }

  const exchangeDynamicDcr = (
    payload: Extract<OAuthSessionPayload, { kind: "dynamic-dcr" }>,
    code: string,
    redirectUrl: string,
  ): Effect.Effect<ExchangeResult, OAuthCompleteError> =>
    Effect.gen(function* () {
      const md = payload.authorizationServerMetadata as {
        token_endpoint: string;
        issuer?: string;
        id_token_signing_alg_values_supported?: string[];
      };
      const ci = payload.clientInformation as {
        client_id: string;
        client_secret?: string;
        token_endpoint_auth_method?: string;
      };
      const tokens = yield* exchangeAuthorizationCode({
        tokenUrl: md.token_endpoint,
        issuerUrl: md.issuer,
        clientId: ci.client_id,
        clientSecret: ci.client_secret ?? undefined,
        redirectUrl,
        codeVerifier: payload.codeVerifier,
        code,
        idTokenSigningAlgValuesSupported: md.id_token_signing_alg_values_supported,
        clientAuth: ci.token_endpoint_auth_method === "client_secret_basic" ? "basic" : "body",
        resource: payload.resource ?? undefined,
        endpointUrlPolicy,
      }).pipe(
        Effect.mapError(
          ({ message, error }: OAuth2Error) =>
            new OAuthCompleteError({
              message: `Token exchange failed: ${message}`,
              code: error,
            }),
        ),
      );
      return {
        tokens,
        endpointForDisplay: payload.authorizationServerUrl,
      };
    });

  const exchangeAuthorizationCodeStrategy = (
    payload: Extract<OAuthSessionPayload, { kind: "authorization-code" }>,
    code: string,
    redirectUrl: string,
  ): Effect.Effect<ExchangeResult, OAuthCompleteError | StorageFailure> =>
    Effect.gen(function* () {
      const clientId = payload.clientIdSecretScopeId
        ? yield* getSecretFromRecordedScope({
            secretId: payload.clientIdSecretId,
            scopeId: payload.clientIdSecretScopeId,
          })
        : yield* deps.secretsGet(payload.clientIdSecretId);
      if (clientId === null) {
        return yield* new OAuthCompleteError({
          message: `client_id secret "${payload.clientIdSecretId}" not found`,
        });
      }
      const clientSecret = payload.clientSecretSecretId
        ? yield* getSecretFromRecordedScope({
            secretId: payload.clientSecretSecretId,
            scopeId: payload.clientSecretSecretScopeId,
          })
        : null;
      if (payload.clientSecretSecretId && clientSecret === null) {
        return yield* new OAuthCompleteError({
          message: `client_secret secret "${payload.clientSecretSecretId}" not found`,
        });
      }

      const tokens = yield* exchangeAuthorizationCode({
        tokenUrl: payload.tokenEndpoint,
        issuerUrl: payload.issuerUrl,
        clientId,
        clientSecret: clientSecret ?? undefined,
        redirectUrl,
        codeVerifier: payload.codeVerifier,
        code,
        clientAuth: payload.clientAuth,
        endpointUrlPolicy,
      }).pipe(
        Effect.mapError(
          ({ message, error }: OAuth2Error) =>
            new OAuthCompleteError({
              message: `Token exchange failed: ${message}`,
              code: error,
            }),
        ),
      );
      return {
        tokens,
        endpointForDisplay: null,
      };
    });

  const cancel = (sessionId: string, tokenScope: string): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* deps.adapter.delete({
        model: "oauth2_session",
        where: [
          { field: "id", value: sessionId },
          { field: "scope_id", value: tokenScope },
        ],
      });
    });

  // -------------------------------------------------------------------
  // Canonical connection provider — refresh handler
  // -------------------------------------------------------------------
  const connectionProvider: ConnectionProvider = {
    key: OAUTH2_PROVIDER_KEY,
    refresh: (input: ConnectionRefreshInput) =>
      Effect.gen(function* () {
        if (!input.providerState) {
          return yield* new ConnectionRefreshError({
            connectionId: input.connectionId,
            message: "oauth2 connection missing providerState",
          });
        }
        const state = yield* Effect.try({
          try: () => decodeProviderState(input.providerState),
          catch: (cause) =>
            new ConnectionRefreshError({
              connectionId: input.connectionId,
              message: "oauth2 providerState is malformed",
              cause,
            }),
        });

        if (state.kind !== "client-credentials" && !input.refreshToken) {
          return yield* new ConnectionRefreshError({
            connectionId: input.connectionId,
            message: "oauth2 connection has no refresh token",
            reauthRequired: true,
          });
        }

        // Resolve client credentials depending on strategy. Dynamic-DCR
        // embeds `client_id` inline (DCR-minted public client);
        // authorization-code reads it off a secret; client-credentials
        // reads both id + secret.
        const { clientId, clientSecret } = yield* Match.value(state).pipe(
          Match.when({ kind: "dynamic-dcr" }, (s) =>
            Effect.gen(function* () {
              const csec = s.clientSecretSecretId
                ? yield* getSecretFromRecordedScope({
                    secretId: s.clientSecretSecretId,
                    scopeId: s.clientSecretSecretScopeId ?? null,
                  }).pipe(
                    Effect.catchTags({
                      StorageError: ({ message, cause }) =>
                        Effect.fail(
                          new ConnectionRefreshError({
                            connectionId: input.connectionId,
                            message: `Failed to resolve DCR client_secret: ${message}`,
                            cause,
                          }),
                        ),
                      UniqueViolationError: (cause) =>
                        Effect.fail(
                          new ConnectionRefreshError({
                            connectionId: input.connectionId,
                            message: "Failed to resolve DCR client_secret: UniqueViolationError",
                            cause,
                          }),
                        ),
                    }),
                  )
                : null;
              if (s.clientSecretSecretId && csec === null) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: `client_secret secret "${s.clientSecretSecretId}" not found`,
                  reauthRequired: true,
                });
              }
              return { clientId: s.clientId, clientSecret: csec };
            }),
          ),
          Match.whenOr({ kind: "authorization-code" }, { kind: "client-credentials" }, (s) =>
            Effect.gen(function* () {
              const cid = yield* getSecretFromRecordedScope({
                secretId: s.clientIdSecretId,
                scopeId: s.clientIdSecretScopeId ?? null,
              }).pipe(
                Effect.catchTags({
                  StorageError: ({ message, cause }) =>
                    Effect.fail(
                      new ConnectionRefreshError({
                        connectionId: input.connectionId,
                        message: `Failed to resolve client_id secret: ${message}`,
                        cause,
                      }),
                    ),
                  UniqueViolationError: (cause) =>
                    Effect.fail(
                      new ConnectionRefreshError({
                        connectionId: input.connectionId,
                        message: "Failed to resolve client_id secret: UniqueViolationError",
                        cause,
                      }),
                    ),
                }),
              );
              if (cid === null) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: `client_id secret "${s.clientIdSecretId}" not found`,
                  reauthRequired: true,
                });
              }
              const csec = s.clientSecretSecretId
                ? yield* getSecretFromRecordedScope({
                    secretId: s.clientSecretSecretId,
                    scopeId: s.clientSecretSecretScopeId ?? null,
                  }).pipe(
                    Effect.catchTags({
                      StorageError: ({ message, cause }) =>
                        Effect.fail(
                          new ConnectionRefreshError({
                            connectionId: input.connectionId,
                            message: `Failed to resolve client_secret: ${message}`,
                            cause,
                          }),
                        ),
                      UniqueViolationError: (cause) =>
                        Effect.fail(
                          new ConnectionRefreshError({
                            connectionId: input.connectionId,
                            message: "Failed to resolve client_secret: UniqueViolationError",
                            cause,
                          }),
                        ),
                    }),
                  )
                : null;
              if (s.clientSecretSecretId && csec === null) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: `client_secret secret "${s.clientSecretSecretId}" not found`,
                  reauthRequired: true,
                });
              }
              return { clientId: cid, clientSecret: csec };
            }),
          ),
          Match.exhaustive,
        );

        const tokenEndpoint = yield* (() => {
          if (state.tokenEndpoint) return Effect.succeed(state.tokenEndpoint);
          return Effect.fail(
            new ConnectionRefreshError({
              connectionId: input.connectionId,
              message: "oauth2 providerState is missing token endpoint",
              reauthRequired: true,
            }),
          );
        })();

        const tokens = yield* (
          state.kind === "client-credentials"
            ? exchangeClientCredentials({
                tokenUrl: tokenEndpoint,
                clientId,
                clientSecret: clientSecret ?? "",
                scopes: state.scopes,
                scopeSeparator: state.scopeSeparator,
                clientAuth: state.clientAuth,
                endpointUrlPolicy,
              })
            : refreshAccessToken({
                tokenUrl: tokenEndpoint,
                issuerUrl:
                  state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                    ? (state.issuerUrl ?? undefined)
                    : undefined,
                clientId,
                clientSecret: clientSecret ?? undefined,
                refreshToken: input.refreshToken!,
                scopes:
                  state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                    ? state.scopes
                    : undefined,
                scopeSeparator:
                  state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                    ? state.scopeSeparator
                    : undefined,
                clientAuth: state.clientAuth,
                idTokenSigningAlgValuesSupported:
                  state.kind === "dynamic-dcr" ? state.idTokenSigningAlgValuesSupported : undefined,
                endpointUrlPolicy,
                resource:
                  state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                    ? (state.resource ?? undefined)
                    : undefined,
              })
        ).pipe(
          Effect.mapError(
            ({ message, error }: OAuth2Error) =>
              new ConnectionRefreshError({
                connectionId: input.connectionId,
                message: `OAuth refresh failed: ${message}`,
                // Terminal RFC 6749 §5.2 errors mean retrying won't heal it.
                reauthRequired: error ? terminalRefreshErrors.has(error) : false,
              }),
          ),
        );

        const expiresAt =
          typeof tokens.expires_in === "number" ? now() + tokens.expires_in * 1000 : null;

        const result: ConnectionRefreshResult = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          oauthScope: tokens.scope ?? input.oauthScope,
          providerState: encodeProviderStateSync({
            ...state,
            tokenEndpoint,
            scope: tokens.scope ?? state.scope,
          }) as Record<string, unknown>,
        };
        return result;
      }),
  };

  const service: OAuthService = { probe, start, complete, cancel };

  return { service, connectionProvider };
};

const safeHostname = (value: string | null): string | null => {
  if (!value) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor is the platform parser; non-URL labels remain display labels
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};
