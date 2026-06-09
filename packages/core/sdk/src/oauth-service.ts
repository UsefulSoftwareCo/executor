// ---------------------------------------------------------------------------
// OAuth service implementation — the runtime behind `executor.oauth` and
// `ctx.oauth`.
//
// v2 model: a client is a registered app carrying its own endpoints; running
// its flow mints a Connection. The client + in-flight session rows are
// owner-scoped core tables; minted access tokens persist through the default
// writable credential provider; tools are produced by `mintOAuthConnection`
// (which the executor wires to the connection-create + tool-production path).
//
// Milestone 2: `start` / `complete` are wired. `start` generates PKCE + a
// branded state, persists an `oauth_session`, and returns the authorize URL
// (authorization_code) or exchanges client credentials immediately. `complete`
// redeems the session, exchanges the code, and mints the connection.
// ---------------------------------------------------------------------------

import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import type { Connection } from "./connection";
import type { IFumaClient, StorageFailure } from "./fuma-runtime";
import { StorageError } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Owner,
  ProviderItemId,
} from "./ids";
import {
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  type ConnectResult,
  type CreateOAuthClientInput,
  type OAuthClientOrigin,
  type OAuthClientSummary,
  type OAuthCompleteInput,
  type OAuthGrant,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
  type OAuthStartInput,
  type RegisterDynamicClientInput,
} from "./oauth-client";
import type { OwnerBinding } from "./plugin";
import type { CredentialProvider } from "./provider";
import {
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  registerDynamicClient as registerDynamicClientDcr,
} from "./oauth-discovery";
import {
  assertSupportedOAuthEndpointUrl,
  buildAuthorizationUrl,
  providerAuthorizeExtras,
  createOAuthState,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";
import { OAUTH2_SESSION_TTL_MS } from "./oauth";

/** Connection-minting input for the OAuth flow — extends a connection create
 *  with the OAuth lifecycle fields (client slug, refresh material, expiry,
 *  granted scope). The executor's `mintOAuthConnection` writes these onto the
 *  `connection` row and produces the connection's tools. */
export interface MintOAuthConnectionInput {
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
  readonly identityLabel?: string | null;
  /** Credential provider key + item id the access token is stored under. */
  readonly provider: string;
  readonly itemId: string;
  readonly oauthClient: OAuthClientSlug;
  /** The owner of `oauthClient` (persisted so refresh loads it by explicit owner). */
  readonly oauthClientOwner: Owner;
  readonly refreshItemId: string | null;
  readonly expiresAt: number | null;
  readonly oauthScope: string | null;
}

/** Everything the OAuth service needs from the executor: fuma access for the
 *  owned `oauth_client` / `oauth_session` tables, the default credential
 *  provider for minted tokens, a `mintOAuthConnection` callback (writes the
 *  connection row + produces tools), the owner binding, and the redirect base. */
export interface OAuthServiceDeps {
  readonly fuma: IFumaClient;
  readonly owner: OwnerBinding;
  readonly tenant: string;
  readonly subject: string | null;
  readonly ownedKeys: (owner: Owner) => {
    readonly tenant: string;
    readonly owner: Owner;
    readonly subject: string;
  };
  readonly defaultWritableProvider: () => CredentialProvider | null;
  /** Write the connection row with OAuth lifecycle fields + produce its tools. */
  readonly mintOAuthConnection: (
    input: MintOAuthConnectionInput,
  ) => Effect.Effect<Connection, StorageFailure>;
  /**
   * Resolve the integration's DECLARED OAuth scopes for a given
   * `(integration, template)` — the scopes the integration's auth template
   * advertises (e.g. an OpenAPI bundle's full authentication-template scope
   * union), NOT the scopes frozen on a specific `oauth_client` row.
   *
   * At connect (`start`) the requested scope set is the UNION of these declared
   * scopes and the client's configured scopes, so reusing a narrow client on a
   * broad integration still requests the integration's full scope set. When the
   * integration declares no OAuth scopes (MCP / DCR integrations discover scopes
   * from the server; integrations with no declared template scopes) this returns
   * `[]` and the union collapses to the client's scopes — current behavior,
   * unchanged.
   */
  readonly resolveDeclaredOAuthScopes: (
    integration: IntegrationSlug,
    template: AuthTemplateSlug,
  ) => Effect.Effect<readonly string[], StorageFailure>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  /**
   * The OAuth callback URL (`${webBaseUrl}${mountPrefix}/oauth/callback`) the host
   * serves and sends to providers on every authorization request + DCR registration.
   * The path carries the host's API mount prefix (cloud: `/api`; root-mounted
   * hosts like local: none), so it matches the route that serves the callback.
   *
   * REQUIRED and EXPLICIT — there is no localhost default. Pass `null` only when
   * the host genuinely has no redirect callback (e.g. a pure client-credentials
   * or non-HTTP context); the redirect-requiring flows (`start` for
   * `authorization_code`, `registerDynamicClient`) then fail loudly instead of
   * silently handing the provider a wrong `http://127.0.0.1/callback`. Hosts
   * that serve OAuth MUST derive this from the request origin / web base URL.
   */
  readonly redirectUri: string | null;
}

type LooseDb = {
  readonly create: (name: string, value: Record<string, unknown>) => Promise<unknown>;
  readonly deleteMany: (name: string, options: unknown) => Promise<void>;
  readonly findFirst: (name: string, options: unknown) => Promise<Record<string, unknown> | null>;
  readonly findMany: (
    name: string,
    options: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
};
const looseDb = (db: unknown): LooseDb => db as LooseDb;

/** Where an OAuth-minted access token is stored in the default provider. The
 *  refresh token lives at the same id with a `:refresh` suffix. */
const accessItemId = (owner: Owner, integration: IntegrationSlug, name: ConnectionName): string =>
  `oauth:${owner}:${integration}:${name}`;
const refreshItemIdFor = (accessId: string): string => `${accessId}:refresh`;

/** Order-preserving de-duplication of a scope list. The requested scope set is
 *  the integration's DECLARED scopes — the integration is the sole source of what
 *  to request; the OAuth app no longer carries a scope set. */
const dedupeScopes = (scopes: readonly string[]): readonly string[] => [...new Set(scopes)];

const decodeJsonPayload = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/** Extract the persisted `requestedScopes` from an `oauth_session.payload`. The
 *  jsonColumn may surface as a parsed object (in-memory backends) or a JSON
 *  string (serialized backends); decode strings before reading. Returns `null`
 *  for legacy sessions written before `requestedScopes` was persisted, so
 *  `complete` can fall back to the client's scopes. */
const requestedScopesFromPayload = (payload: unknown): readonly string[] | null => {
  const decoded =
    typeof payload === "string"
      ? decodeJsonPayload(payload).pipe(Option.getOrElse(() => payload))
      : payload;
  if (decoded === null || typeof decoded !== "object") return null;
  const value = (decoded as Record<string, unknown>).requestedScopes;
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : null;
};

/** Read the app owner `start` recorded on the session payload. Null when absent
 *  (same-owner connects, or sessions written before this field), so `complete`
 *  falls back to the session owner. */
const clientOwnerFromPayload = (payload: unknown): Owner | null => {
  const decoded =
    typeof payload === "string"
      ? decodeJsonPayload(payload).pipe(Option.getOrElse(() => payload))
      : payload;
  if (decoded === null || typeof decoded !== "object") return null;
  const value = (decoded as Record<string, unknown>).clientOwner;
  return value === "user" || value === "org" ? value : null;
};

/** Narrow a stored `grant` string to the `OAuthGrant` union, or `null` when the
 *  value is neither known grant. EXPLICIT — there is no silent fallback to
 *  `authorization_code`; an unknown grant means a corrupt row and callers that
 *  drive token exchange (`loadClient`) must fail loudly rather than guessing. */
const parseGrant = (grant: unknown): OAuthGrant | null =>
  grant === "client_credentials" || grant === "authorization_code" ? grant : null;

const parseOAuthClientOrigin = (row: {
  readonly slug?: unknown;
  readonly grant?: unknown;
  readonly resource?: unknown;
  readonly origin_kind?: unknown;
  readonly origin_integration?: unknown;
}): OAuthClientOrigin => {
  if (row.origin_kind === "dynamic_client_registration") {
    return {
      kind: "dynamic_client_registration",
      integration:
        row.origin_integration == null
          ? null
          : IntegrationSlug.make(String(row.origin_integration)),
    };
  }
  const slug = row.slug == null ? "" : String(row.slug);
  const resource = row.resource == null ? "" : String(row.resource);
  if (
    row.origin_kind == null &&
    row.grant === "authorization_code" &&
    /(^|[-_])mcp($|[-_])/.test(slug) &&
    /(^|\/)mcp($|[/?#])/.test(resource)
  ) {
    return { kind: "dynamic_client_registration", integration: null };
  }
  return { kind: "manual" };
};

interface LoadedOAuthClient {
  readonly slug: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly grant: OAuthGrant;
  readonly clientId: string;
  /** Resolved literal secret (read from the provider via the stored item id). */
  readonly clientSecret: string;
  readonly resource: string | null;
}

/** Where an OAuth app's client secret is stored in the default writable
 *  provider — derived solely from the app's (owner, slug) identity. */
const clientSecretItemId = (owner: Owner, slug: OAuthClientSlug): string =>
  `oauth-client:${owner}:${slug}:secret`;

const expiresAtFrom = (token: OAuth2TokenResponse): number | null =>
  typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : null;

/** Error message surfaced when a redirect-requiring OAuth flow runs on an
 *  executor that was constructed without a `redirectUri`. Previously this path
 *  silently used `http://127.0.0.1/callback`, which providers stored as the
 *  client's callback and then rejected (or worse, accepted, handing tokens to
 *  localhost). Fail loudly so the misconfiguration is caught at the call site. */
const REDIRECT_URI_REQUIRED_MESSAGE =
  "OAuth redirect flow requires a configured redirectUri, but none was provided " +
  "to the executor. Pass `redirectUri` to createExecutor (hosts derive it from " +
  "the web base URL / request origin as `${webBaseUrl}${mountPrefix}/oauth/callback`).";

const canonicalUrlString = (value: string): string => {
  const url = new URL(value.trim());
  url.hash = "";
  return url.toString();
};

const isWellKnownOAuthMetadataUrl = (value: string): boolean => {
  const path = new URL(value.trim()).pathname.toLowerCase();
  return (
    path.includes("/.well-known/oauth-authorization-server") ||
    path.includes("/.well-known/openid-configuration") ||
    path.includes("/.well-known/oauth-protected-resource")
  );
};

const validateSupportedEndpoint = (
  value: string,
  label: string,
  endpointUrlPolicy: OAuthEndpointUrlPolicy | undefined,
): Effect.Effect<void, StorageFailure> =>
  Effect.try({
    try: () => assertSupportedOAuthEndpointUrl(value, label, endpointUrlPolicy),
    catch: (cause) =>
      new StorageError({
        message: `Invalid OAuth client endpoint configuration: ${label} must use https: or loopback http:.`,
        cause,
      }),
  }).pipe(Effect.asVoid);

const validateClientEndpoints = (
  input: CreateOAuthClientInput,
  endpointUrlPolicy: OAuthEndpointUrlPolicy | undefined,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* validateSupportedEndpoint(input.tokenUrl, "token_url", endpointUrlPolicy);
    if (input.resource != null && input.resource.trim().length > 0) {
      yield* validateSupportedEndpoint(input.resource, "resource", endpointUrlPolicy);
    }
    if (input.grant !== "authorization_code") return;
    yield* validateSupportedEndpoint(
      input.authorizationUrl,
      "authorization_url",
      endpointUrlPolicy,
    );
    if (isWellKnownOAuthMetadataUrl(input.authorizationUrl)) {
      return yield* new StorageError({
        message:
          "Invalid OAuth client endpoint configuration: authorization_url must be the OAuth authorization endpoint, not a .well-known metadata URL.",
        cause: undefined,
      });
    }
    if (canonicalUrlString(input.authorizationUrl) === canonicalUrlString(input.tokenUrl)) {
      return yield* new StorageError({
        message:
          "Invalid OAuth client endpoint configuration: authorization_url must not equal token_url.",
        cause: undefined,
      });
    }
  });

export const makeOAuthService = (deps: OAuthServiceDeps): OAuthService => {
  const httpClientLayer = deps.httpClientLayer ?? FetchHttpClient.layer;
  // EXPLICIT — no localhost default. `null` means this executor has no OAuth
  // callback; redirect-requiring flows fail loudly via `requireRedirectUri`.
  const redirectUri = deps.redirectUri;

  // -----------------------------------------------------------------------
  // createClient — write the oauth_client row.
  // -----------------------------------------------------------------------
  const createClient = (
    input: CreateOAuthClientInput,
  ): Effect.Effect<OAuthClientSlug, StorageFailure> =>
    Effect.gen(function* () {
      yield* validateClientEndpoints(input, deps.endpointUrlPolicy);
      const keys = yield* Effect.try({
        try: () => deps.ownedKeys(input.owner),
        catch: (cause) =>
          new StorageError({
            message: "Cannot write oauth_client for owner without a subject",
            cause,
          }),
      });
      const now = new Date();

      // Store the secret out-of-band in the default writable provider; the row
      // keeps only its item id. A public/PKCE client (empty secret) stores null
      // — there is no plaintext column to fall back to (the schema dropped it).
      let clientSecretItemIdValue: string | null = null;
      if (input.clientSecret.length > 0) {
        const provider = deps.defaultWritableProvider();
        if (!provider || !provider.set) {
          return yield* new StorageError({
            message:
              "No default writable credential provider is registered to store the OAuth client secret.",
            cause: undefined,
          });
        }
        clientSecretItemIdValue = clientSecretItemId(input.owner, input.slug);
        yield* provider.set(ProviderItemId.make(clientSecretItemIdValue), input.clientSecret);
      }

      yield* deps.fuma
        .use("oauth_client.deleteExisting", (db) =>
          looseDb(db).deleteMany("oauth_client", {
            where: (b: any) =>
              b.and(b("owner", "=", input.owner), b("slug", "=", String(input.slug))),
          }),
        )
        .pipe(Effect.catch(() => Effect.void));
      yield* deps.fuma.use("oauth_client.create", (db) =>
        looseDb(db).create("oauth_client", {
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          slug: String(input.slug),
          authorization_url: input.authorizationUrl,
          token_url: input.tokenUrl,
          grant: input.grant,
          client_id: input.clientId,
          client_secret_item_id: clientSecretItemIdValue,
          resource: input.resource ?? null,
          origin_kind: input.origin?.kind ?? "manual",
          origin_integration:
            input.origin?.kind === "dynamic_client_registration"
              ? input.origin.integration == null
                ? null
                : String(input.origin.integration)
              : null,
          created_at: now,
        }),
      );
      return input.slug;
    });

  // -----------------------------------------------------------------------
  // removeClient — permanently delete an owner-scoped oauth_client row.
  //
  // Mirrors createClient's deleteExisting filter (same (owner, slug) key) but
  // does NOT swallow storage errors: createClient pipes `.catch(() =>
  // Effect.void)` because a missing prior row is fine on upsert, whereas a real
  // removal must surface a storage failure loudly. The owner policy on
  // `oauth_client` narrows visibility, so a cross-subject user row cannot be
  // deleted. `deleteMany` is idempotent (no matching row -> no-op), so removing
  // an already-gone client returns success — acceptable for a delete. The
  // connection rows that referenced the slug keep their stored value and fail at
  // the next token refresh, prompting a reconnect (graceful degradation; this
  // op never cascades into connections).
  // -----------------------------------------------------------------------
  const removeClient = (owner: Owner, slug: OAuthClientSlug): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      yield* deps.fuma
        .use("oauth_client.delete", (db) =>
          looseDb(db).deleteMany("oauth_client", {
            where: (b: any) => b.and(b("owner", "=", owner), b("slug", "=", String(slug))),
          }),
        )
        .pipe(Effect.asVoid);
      // Best-effort: drop the secret from the provider so it isn't orphaned.
      const provider = deps.defaultWritableProvider();
      if (provider?.delete) {
        yield* provider
          .delete(ProviderItemId.make(clientSecretItemId(owner, slug)))
          .pipe(Effect.catch(() => Effect.void));
      }
    });

  // -----------------------------------------------------------------------
  // registerDynamicClient — RFC 7591 Dynamic Client Registration.
  //
  // POSTs the server's registration_endpoint to mint a client_id (public,
  // PKCE-only, no secret when the server allows `none`; else
  // `client_secret_post`), then persists it through createClient's path. The
  // user pastes NO client id/secret — that is the point. The minted secret is
  // never returned over the read surface.
  // -----------------------------------------------------------------------
  // DCR auth-method negotiation. This is an EXPLICIT, documented choice (not a
  // silent guess): a Dynamic Client Registration ALWAYS mints a public PKCE
  // client — `none` when the server advertises nothing or lists `none`, and
  // `client_secret_post` only when the server's advertised methods exclude
  // `none` (so a confidential secret is mandatory). Static clients never reach
  // here; they require an explicit grant + secret in `createClient`.
  const pickDcrAuthMethod = (
    advertised: readonly string[] | undefined,
  ): "none" | "client_secret_post" =>
    !advertised || advertised.length === 0 || advertised.includes("none")
      ? "none"
      : "client_secret_post";

  const registerDynamicClient = (
    input: RegisterDynamicClientInput,
  ): Effect.Effect<OAuthClientSlug, OAuthRegisterDynamicError | StorageFailure> =>
    Effect.gen(function* () {
      const flowRedirectUri = input.redirectUri ?? redirectUri;
      // DCR registers our callback as the client's redirect_uri — fail loudly
      // if the executor has none rather than registering a localhost URL.
      if (flowRedirectUri == null) {
        return yield* new OAuthRegisterDynamicError({
          message: REDIRECT_URI_REQUIRED_MESSAGE,
        });
      }
      const authMethod = pickDcrAuthMethod(input.tokenEndpointAuthMethodsSupported);
      const information = yield* registerDynamicClientDcr(
        {
          registrationEndpoint: input.registrationEndpoint,
          metadata: {
            client_name: input.clientName,
            redirect_uris: [flowRedirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: authMethod,
            scope: input.scopes.length > 0 ? input.scopes.join(" ") : undefined,
          },
        },
        { httpClientLayer, endpointUrlPolicy: deps.endpointUrlPolicy },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OAuthRegisterDynamicError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message` field
              message: `Dynamic Client Registration failed: ${cause.message}`,
            }),
        ),
      );

      // Persist the minted client. DCR-minted public clients have no secret; we
      // store "" so the PKCE-only token exchange omits `client_secret`.
      // Confidential DCR clients keep the returned secret in the credential
      // provider. The persisted grant is interactive authorization_code.
      // `input.scopes` was already sent to the AS at registration above; the
      // stored client carries no scope set (the integration drives requests).
      yield* createClient({
        owner: input.owner,
        slug: input.slug,
        authorizationUrl: input.authorizationUrl,
        tokenUrl: input.tokenUrl,
        resource: input.resource ?? null,
        grant: "authorization_code",
        clientId: information.client_id,
        clientSecret: information.client_secret ?? "",
        origin: {
          kind: "dynamic_client_registration",
          integration: input.originIntegration ?? null,
        },
      });
      return input.slug;
    });

  // -----------------------------------------------------------------------
  // listClients — metadata-only summaries of every client the caller can see.
  // The owner policy on `oauth_client` already narrows `findMany` to the
  // tenant's org rows + this subject's own user rows, so no explicit filter is
  // needed. The `client_secret` column is deliberately never projected.
  // -----------------------------------------------------------------------
  const listClients = (): Effect.Effect<readonly OAuthClientSummary[], StorageFailure> =>
    deps.fuma
      .use("oauth_client.findMany", (db) => looseDb(db).findMany("oauth_client", {}))
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => {
            const grant = parseGrant(row.grant);
            // EXPLICIT — a row with an unknown grant is corrupt; surface it
            // loudly rather than silently displaying it as authorization_code.
            if (grant === null) {
              return Effect.fail(
                new StorageError({
                  message: `oauth_client ${String(row.slug)} has an unknown grant: ${String(row.grant)}`,
                  cause: undefined,
                }),
              );
            }
            return Effect.succeed({
              owner: String(row.owner) as Owner,
              slug: OAuthClientSlug.make(String(row.slug)),
              grant,
              authorizationUrl: String(row.authorization_url),
              tokenUrl: String(row.token_url),
              resource: row.resource == null ? null : String(row.resource),
              clientId: String(row.client_id),
              origin: parseOAuthClientOrigin(row),
            } satisfies OAuthClientSummary);
          }),
        ),
      );

  // -----------------------------------------------------------------------
  // Load an oauth_client row by (owner, slug).
  // -----------------------------------------------------------------------
  const loadClient = (
    owner: Owner,
    slug: OAuthClientSlug,
  ): Effect.Effect<LoadedOAuthClient | null, StorageFailure> =>
    deps.fuma
      .use("oauth_client.findFirst", (db) =>
        looseDb(db).findFirst("oauth_client", {
          where: (b: any) => b.and(b("owner", "=", owner), b("slug", "=", String(slug))),
        }),
      )
      .pipe(
        Effect.flatMap((row) => {
          if (!row) return Effect.succeed(null);
          const grant = parseGrant(row.grant);
          // EXPLICIT — this row drives the token exchange. An unknown grant is a
          // corrupt row; fail loudly rather than guessing authorization_code and
          // running the wrong flow.
          if (grant === null) {
            return Effect.fail(
              new StorageError({
                message: `oauth_client ${String(slug)} has an unknown grant: ${String(row.grant)}`,
                cause: undefined,
              }),
            );
          }
          // `client_secret_item_id` is null for DCR-minted / public PKCE clients;
          // the token exchange treats a missing secret as "public client, omit
          // client_secret" (see pickClientAuth). A confidential client persisted
          // its secret to the provider in createClient; resolve it back here.
          return Effect.gen(function* () {
            let clientSecret = "";
            if (row.client_secret_item_id != null) {
              const provider = deps.defaultWritableProvider();
              if (provider) {
                clientSecret =
                  (yield* provider.get(ProviderItemId.make(String(row.client_secret_item_id)))) ??
                  "";
              }
            }
            return {
              slug: String(row.slug),
              authorizationUrl: String(row.authorization_url),
              tokenUrl: String(row.token_url),
              grant,
              clientId: String(row.client_id),
              clientSecret,
              resource: row.resource == null ? null : String(row.resource),
            } satisfies LoadedOAuthClient;
          });
        }),
      );

  // -----------------------------------------------------------------------
  // start — begin a flow through a client to mint a connection.
  // -----------------------------------------------------------------------
  const start = (
    input: OAuthStartInput,
  ): Effect.Effect<ConnectResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const keys = yield* Effect.try({
        try: () => deps.ownedKeys(input.owner),
        catch: (cause) =>
          new StorageError({
            message: "Cannot start OAuth flow for owner without a subject",
            cause,
          }),
      });
      // Sharing is one-directional (org → members): a Workspace (org) connection
      // cannot be backed by a member's private (user) app. The connection owner
      // and the app owner are otherwise independent — a Personal connection
      // through a shared Workspace app is the supported cross-owner case.
      if (input.owner === "org" && input.clientOwner === "user") {
        return yield* new OAuthStartError({
          message: "A Workspace connection must use a Workspace app.",
        });
      }
      // Load the app by its EXPLICIT owner (the caller knows it — no derivation).
      // The connection is still minted under `input.owner`. Storage visibility
      // policy hides apps the actor cannot see, so a wrong owner yields null.
      const client = yield* loadClient(input.clientOwner, input.client);
      if (!client) {
        return yield* new OAuthStartError({
          message: `OAuth client not found: ${input.client}`,
        });
      }

      // The INTEGRATION is the sole source of what to request — its declared auth
      // scopes (driven by the integration's tools, surfaced via the declared auth
      // method). The OAuth app no longer carries a scope set, so there is no union
      // to compute and no way to over-request from a stale client copy.
      const declaredScopes = yield* deps
        .resolveDeclaredOAuthScopes(input.integration, input.template)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                message: `Failed to resolve declared OAuth scopes: ${cause.message}`,
              }),
          ),
        );
      const requestedScopes = dedupeScopes(declaredScopes);

      // client_credentials: exchange immediately and mint the connection.
      if (client.grant === "client_credentials") {
        const token = yield* exchangeClientCredentials({
          tokenUrl: client.tokenUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          scopes: requestedScopes,
          resource: client.resource ?? undefined,
          endpointUrlPolicy: deps.endpointUrlPolicy,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message` field
                message: `OAuth client-credentials exchange failed: ${cause.message}`,
              }),
          ),
        );
        const connection = yield* mintFromToken(
          input,
          client,
          token,
          requestedScopes,
          input.clientOwner,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                message: `Failed to mint OAuth connection: ${cause.message}`,
              }),
          ),
        );
        return { status: "connected", connection } as const;
      }

      // authorization_code requires our callback to receive the code — fail
      // loudly if the executor was constructed without a redirectUri rather
      // than persisting a session pointed at a wrong localhost callback.
      const flowRedirectUri = input.redirectUri ?? redirectUri;
      if (flowRedirectUri == null) {
        return yield* new OAuthStartError({
          message: REDIRECT_URI_REQUIRED_MESSAGE,
        });
      }

      // authorization_code: persist a session + build the authorize URL.
      const verifier = createPkceCodeVerifier();
      const challenge = yield* Effect.promise(() => createPkceCodeChallenge(verifier));
      const state = OAuthState.make(createOAuthState());

      const now = new Date();
      const expiresAt = Date.now() + OAUTH2_SESSION_TTL_MS;
      yield* deps.fuma.use("oauth_session.create", (db) =>
        looseDb(db).create("oauth_session", {
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          state: String(state),
          client_slug: String(input.client),
          integration: String(input.integration),
          name: String(input.name),
          template: String(input.template),
          redirect_url: flowRedirectUri,
          pkce_verifier: verifier,
          identity_label: input.identityLabel ?? null,
          // Persist the requested scope set (declared ∪ client) so `complete`'s
          // recorded-scope fallback reflects exactly what was requested when the
          // AS omits `scope`, without re-resolving the integration's declared
          // scopes at completion.
          payload: { owner: input.owner, clientOwner: input.clientOwner, requestedScopes },
          expires_at: expiresAt,
          created_at: now,
        }),
      );

      const authorizationUrl = yield* Effect.try({
        try: () =>
          buildAuthorizationUrl({
            authorizationUrl: client.authorizationUrl,
            clientId: client.clientId,
            redirectUrl: flowRedirectUri,
            scopes: requestedScopes,
            state: String(state),
            codeChallenge: challenge,
            resource: client.resource ?? undefined,
            // Provider quirks (Google: access_type=offline + prompt=consent) —
            // without these Google returns no refresh token and won't re-consent
            // to widen scopes on reconnect.
            extraParams: providerAuthorizeExtras(client.authorizationUrl),
            endpointUrlPolicy: deps.endpointUrlPolicy,
          }),
        catch: (cause) =>
          new OAuthStartError({
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: surface the URL-construction failure
            message: `Failed to build authorization URL: ${String(cause)}`,
          }),
      });

      return { status: "redirect", authorizationUrl, state } as const;
    });

  // -----------------------------------------------------------------------
  // complete — redeem the session, exchange the code, mint the connection.
  // -----------------------------------------------------------------------
  const complete = (
    input: OAuthCompleteInput,
  ): Effect.Effect<Connection, OAuthCompleteError | OAuthSessionNotFoundError | StorageFailure> =>
    Effect.gen(function* () {
      const sessionRow = yield* deps.fuma.use("oauth_session.findFirst", (db) =>
        looseDb(db).findFirst("oauth_session", {
          where: (b: any) => b("state", "=", String(input.state)),
        }),
      );
      if (!sessionRow) {
        return yield* new OAuthSessionNotFoundError({ state: input.state });
      }
      const session = {
        owner: String(sessionRow.owner) as Owner,
        clientSlug: OAuthClientSlug.make(String(sessionRow.client_slug)),
        integration: IntegrationSlug.make(String(sessionRow.integration)),
        name: ConnectionName.make(String(sessionRow.name)),
        template: AuthTemplateSlug.make(String(sessionRow.template)),
        redirectUrl: String(sessionRow.redirect_url),
        pkceVerifier: sessionRow.pkce_verifier == null ? null : String(sessionRow.pkce_verifier),
        identityLabel: sessionRow.identity_label == null ? null : String(sessionRow.identity_label),
        expiresAt: Number(sessionRow.expires_at),
        // The scope set `start` requested (declared ∪ client), persisted on the
        // session payload. Drives the recorded-scope fallback when the AS omits
        // `scope`. Missing/legacy payloads fall back to the client's scopes below.
        requestedScopes: requestedScopesFromPayload(sessionRow.payload),
        // The app's owner, recorded by `start` — reload the SAME app at
        // completion by explicit owner (no derivation). Defaults to the session
        // owner for same-owner connects.
        clientOwner:
          clientOwnerFromPayload(sessionRow.payload) ?? (String(sessionRow.owner) as Owner),
      };

      // Expired sessions are not redeemable — drop + treat as not found.
      if (Number.isFinite(session.expiresAt) && session.expiresAt <= Date.now()) {
        yield* deleteSession(input.state);
        return yield* new OAuthSessionNotFoundError({ state: input.state });
      }

      // Reload the SAME app `start` resolved, by its explicit recorded owner.
      const client = yield* loadClient(session.clientOwner, session.clientSlug);
      if (!client) {
        return yield* new OAuthCompleteError({
          message: `OAuth client not found: ${session.clientSlug}`,
          restartRequired: true,
        });
      }

      // The PKCE verifier is minted by `start` for every authorization_code
      // session. A null/missing one means a corrupt session row — exchanging
      // with an empty verifier would violate RFC 7636 and the AS would reject
      // it with an opaque error. Fail loudly + require a restart instead.
      if (session.pkceVerifier == null) {
        return yield* new OAuthCompleteError({
          message: `OAuth session ${input.state} is missing its PKCE code verifier; restart the flow.`,
          restartRequired: true,
        });
      }

      const token = yield* exchangeAuthorizationCode({
        tokenUrl: client.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUrl: session.redirectUrl,
        codeVerifier: session.pkceVerifier,
        code: input.code,
        resource: client.resource ?? undefined,
        endpointUrlPolicy: deps.endpointUrlPolicy,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OAuthCompleteError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message` field
              message: `OAuth code exchange failed: ${cause.message}`,
              restartRequired: cause.error === "invalid_grant",
            }),
        ),
      );

      const connection = yield* mintFromToken(
        {
          owner: session.owner,
          name: session.name,
          integration: session.integration,
          template: session.template,
          identityLabel: session.identityLabel,
        },
        client,
        token,
        // The scopes `start` requested (the integration's declared set), persisted
        // on the session. Empty only for a corrupt/legacy session with no payload.
        session.requestedScopes ?? [],
        session.clientOwner,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OAuthCompleteError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
              message: `Failed to mint OAuth connection: ${cause.message}`,
              restartRequired: false,
            }),
        ),
      );

      yield* deleteSession(input.state);
      return connection;
    });

  // -----------------------------------------------------------------------
  // Mint the connection from a freshly exchanged token: store the access
  // value (+ refresh) in the default writable provider, then write the
  // connection row with OAuth lifecycle fields + produce its tools.
  // -----------------------------------------------------------------------
  const mintFromToken = (
    target: {
      readonly owner: Owner;
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly identityLabel?: string | null;
    },
    client: LoadedOAuthClient,
    token: OAuth2TokenResponse,
    /** The scope set requested at /authorize + /token (declared ∪ client) —
     *  the recorded-scope fallback when the AS omits `scope`. */
    requestedScopes: readonly string[],
    /** The owner of `client` — persisted so refresh loads it by explicit owner. */
    clientOwner: Owner,
  ): Effect.Effect<Connection, StorageFailure> =>
    Effect.gen(function* () {
      const provider = deps.defaultWritableProvider();
      if (!provider || !provider.set) {
        return yield* new StorageError({
          message:
            "No default writable credential provider is registered to store the OAuth access token.",
          cause: undefined,
        });
      }
      const itemId = accessItemId(target.owner, target.integration, target.name);
      yield* provider.set(ProviderItemId.make(itemId), token.access_token);

      let refreshItemId: string | null = null;
      if (token.refresh_token) {
        refreshItemId = refreshItemIdFor(itemId);
        yield* provider.set(ProviderItemId.make(refreshItemId), token.refresh_token);
      }

      return yield* deps.mintOAuthConnection({
        owner: target.owner,
        name: target.name,
        integration: target.integration,
        template: target.template,
        identityLabel: target.identityLabel ?? null,
        provider: String(provider.key),
        itemId,
        oauthClient: OAuthClientSlug.make(client.slug),
        oauthClientOwner: clientOwner,
        refreshItemId,
        expiresAt: expiresAtFrom(token),
        // Benign fallback (kept by design): record the granted scope the AS
        // echoed back; when it omits `scope` (some servers do), fall back to the
        // scopes we requested (declared ∪ client). This only affects the recorded
        // scope label, not what the token can do, so a guess here masks no
        // misconfiguration.
        oauthScope: token.scope ?? (requestedScopes.join(" ") || null),
      });
    });

  const deleteSession = (state: OAuthState): Effect.Effect<void, StorageFailure> =>
    deps.fuma
      .use("oauth_session.delete", (db) =>
        looseDb(db).deleteMany("oauth_session", {
          where: (b: any) => b("state", "=", String(state)),
        }),
      )
      .pipe(Effect.asVoid);

  // -----------------------------------------------------------------------
  // cancel — drop an in-flight session.
  // -----------------------------------------------------------------------
  const cancel = (state: OAuthState): Effect.Effect<void, StorageFailure> => deleteSession(state);

  // -----------------------------------------------------------------------
  // probe — RFC 8414 / OIDC discovery for onboarding pre-fill.
  // -----------------------------------------------------------------------
  const probe = (
    input: OAuthProbeInput,
  ): Effect.Effect<OAuthProbeResult, OAuthProbeError | StorageFailure> =>
    Effect.gen(function* () {
      const options = { endpointUrlPolicy: deps.endpointUrlPolicy };
      // Try protected-resource metadata first (RFC 9728), then the AS issuer.
      const resource = yield* discoverProtectedResourceMetadata(input.url, options).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      // EXPLICIT discovery order: when the protected-resource metadata advertises
      // an authorization server, probe that; otherwise probe the input endpoint
      // itself as a last resort. This is a documented probe order, not a silent
      // guess — a probe that finds no AS metadata fails loudly below.
      const issuerCandidate = resource?.metadata.authorization_servers?.[0] ?? input.url;
      const as = yield* discoverAuthorizationServerMetadata(issuerCandidate, options).pipe(
        Effect.mapError(
          (cause) =>
            new OAuthProbeError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message` field
              message: `OAuth discovery failed: ${cause.message}`,
            }),
        ),
      );
      if (!as) {
        return yield* new OAuthProbeError({
          message: `No OAuth authorization-server metadata found at ${input.url}`,
        });
      }
      return {
        authorizationUrl: as.metadata.authorization_endpoint,
        tokenUrl: as.metadata.token_endpoint,
        resource: resource?.metadata.resource ?? null,
        scopesSupported: as.metadata.scopes_supported,
        registrationEndpoint: as.metadata.registration_endpoint ?? null,
        tokenEndpointAuthMethodsSupported: as.metadata.token_endpoint_auth_methods_supported,
      } satisfies OAuthProbeResult;
    }).pipe(Effect.provide(httpClientLayer));

  return {
    createClient,
    removeClient,
    registerDynamicClient,
    listClients,
    start,
    complete,
    cancel,
    probe,
  };
};
