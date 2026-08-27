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

import { Duration, Effect, Layer, Match, Option, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import { connectionIdentifier } from "./connection-name-identifier";
import type { AuditEventInput } from "./audit";
import type { Connection } from "./connection";
import type { OrgWriteDeniedError } from "./errors";
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
  DEFAULT_SUBJECT_TOKEN_TYPE,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  firstPartyOAuthClientAllowsScopes,
  firstPartyOAuthClientSlug,
  isFirstPartyOAuthClientSlug,
  type ConnectResult,
  type CreateOAuthClientInput,
  type EnterpriseManagedStartInput,
  type FirstPartyOAuthClientConfig,
  type OAuthClientOrigin,
  type OAuthClientSummary,
  type OAuthCompleteInput,
  type OAuthGrant,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
  type OAuthStartInput,
  type RegisterDynamicClientInput,
  type SubjectTokenType,
} from "./oauth-client";
import type { OwnerBinding } from "./plugin";
import type { CredentialProvider } from "./provider";
import {
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  OAuthDiscoveryError,
  registerDynamicClient as registerDynamicClientDcr,
  type OAuthAuthorizationServerMetadata,
} from "./oauth-discovery";
import {
  ENTERPRISE_MANAGED_ROLLOUT_ENABLED,
  runEnterpriseManagedAuthorization,
  type EnterpriseManagedConnectionState,
  type EnterpriseManagedGrant,
  type EnterpriseManagedMintError,
  type EnterpriseManagedRollout,
  type EnterpriseManagedRolloutContext,
  type EnterpriseManagedRolloutDecision,
  type EnterpriseManagedRolloutEvent,
} from "./oauth-ema";
import {
  assertSupportedOAuthEndpointUrl,
  buildAuthorizationUrl,
  providerAuthorizeExtras,
  createOAuthState,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  isLoopbackHttpUrl,
  rebindTokenEndpointHostToCallbackDomain,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";
import { OAUTH2_SESSION_TTL_MS, encodeOAuthCallbackState } from "./oauth";
import { canonicalIssuerUrl, hostOfUrl, isDcrClassifiedRow, parseUrl } from "./oauth-gc";

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
  /** Display label derived from the provider (OIDC id_token claims), as opposed
   *  to `identityLabel` which the user chose. Only fills an EMPTY label slot:
   *  a re-mint must never clobber a curated label with a derived one. */
  readonly derivedIdentityLabel?: string | null;
  /** Credential provider key + item id the access token is stored under. */
  readonly provider: string;
  readonly itemId: string;
  readonly oauthClient: OAuthClientSlug;
  /** The owner of `oauthClient` (persisted so refresh loads it by explicit owner). */
  readonly oauthClientOwner: Owner;
  readonly refreshItemId: string | null;
  readonly expiresAt: number | null;
  readonly oauthScope: string | null;
  readonly missingOAuthScopes?: readonly string[];
  /** Enterprise-managed authorization wiring, for connections minted through
   *  the ID-JAG grant profile. Persisted on the connection so token renewal can
   *  re-run the exchange without the user. Omitted for every other grant. */
  readonly enterpriseManaged?: EnterpriseManagedConnectionState;
  /** Per-connection override for the token endpoint, persisted only when the
   *  code was redeemed at a region other than the client's configured token
   *  host (Datadog multi-site). Null means refresh uses the client's token URL. */
  readonly oauthTokenUrl?: string | null;
}

/** Project an enterprise-managed mint failure onto the connect boundary,
 *  KEEPING the taxonomy structural. `EmaPolicyDenied` is the one verdict a
 *  console must treat differently from every other start failure: it means the
 *  administrator declined, so re-authenticating cannot help and the ordinary
 *  per-server flow must not be offered as a way around it. That decision has to
 *  be readable as a field — a UI cannot branch on a sentence. */
const startErrorFromEnterpriseManaged = (cause: EnterpriseManagedMintError): OAuthStartError => {
  const rendered = (failure: EnterpriseManagedMintError): string =>
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: every EMA error declares `message` as a getter over its own typed fields, so this is a projection of a typed failure, not a read off an unknown throwable
    failure.message;
  return Match.value(cause).pipe(
    Match.tag(
      "EmaPolicyDenied",
      (denied) =>
        new OAuthStartError({
          message: rendered(denied),
          blockedByAdmin: true,
          oauthErrorCode: denied.error,
        }),
    ),
    Match.tag(
      "EmaRedemptionRejected",
      (rejected) =>
        new OAuthStartError({
          message: rendered(rejected),
          ...(rejected.error === undefined ? {} : { oauthErrorCode: rejected.error }),
        }),
    ),
    Match.tag(
      "EmaSubjectTokenRejected",
      "EmaUpstreamUnavailable",
      (failure) => new OAuthStartError({ message: rendered(failure) }),
    ),
    Match.exhaustive,
  );
};

/** The OAuth scope policy for a `(integration, template)`. Either the
 *  integration declares the scopes to request (`scopes`, possibly empty — an
 *  empty set requests no scopes), or it declares none and the request scopes
 *  are discovered from the server's metadata at connect (`discover`, used by
 *  MCP). The two are mutually exclusive by construction. */
export type OAuthScopePolicy =
  | { readonly kind: "scopes"; readonly scopes: readonly string[] }
  | { readonly kind: "discover" };

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
  /** Workspace-settings gate from the executor binding
   *  (`ExecutorConfig.orgWrites`): refuses `owner: "org"` targets on the
   *  user-intent client/connect surfaces. */
  readonly guardOrgWrite: (owner: Owner) => Effect.Effect<void, OrgWriteDeniedError>;
  readonly recordAuditEvent: (input: AuditEventInput) => Effect.Effect<void, StorageFailure>;
  readonly defaultWritableProvider: () => CredentialProvider | null;
  /** Write the connection row with OAuth lifecycle fields + produce its tools. */
  readonly mintOAuthConnection: (
    input: MintOAuthConnectionInput,
  ) => Effect.Effect<Connection, StorageFailure>;
  /** Whether a connection row exists under `(owner, integration, name)`: the
   *  raw row, not the policy-filtered list, so `start` can resolve a free
   *  name for `newConnection` flows against what is actually stored. */
  readonly connectionNameTaken: (ref: {
    readonly owner: Owner;
    readonly integration: IntegrationSlug;
    readonly name: ConnectionName;
  }) => Effect.Effect<boolean, StorageFailure>;
  /**
   * Resolve the OAuth scope policy for a `(integration, template)`:
   *  - `{ kind: "scopes", scopes }`: the scopes the integration's auth template
   *    DECLARES (e.g. an OpenAPI bundle's authentication-template scope union),
   *    NOT the scopes frozen on a specific `oauth_client` row. These are
   *    requested verbatim at connect (`start`); an empty set requests none.
   *  - `{ kind: "discover" }`: the integration declares no scopes, so `start`
   *    discovers the request scopes from the server's RFC 9728 / RFC 8414
   *    metadata. Used by server-targeting integrations (MCP) whose scopes live
   *    on the server rather than in a template.
   */
  readonly resolveOAuthScopePolicy: (
    integration: IntegrationSlug,
    template: AuthTemplateSlug,
  ) => Effect.Effect<OAuthScopePolicy, StorageFailure>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  /**
   * Host-owned rollout gate for enterprise-managed authorization (see
   * {@link EnterpriseManagedRollout}). Consulted ONCE per `id_jag` connect,
   * before discovery, and never again — not after the IdP has ruled, and not on
   * the credential-refresh path, which follows the state persisted on the
   * connection instead.
   *
   * OMITTED means enterprise-managed authorization is attempted, which is what
   * every host did before this seam existed. Only a host that actually operates
   * a flag service supplies one; core takes no dependency on any.
   */
  readonly enterpriseManagedRollout?: EnterpriseManagedRollout;
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
  /** URL selected organization slug to round-trip through OAuth `state`. */
  readonly callbackStateOrgSlug?: string | null;
  /** Host-operated apps declared at composition time (`first-party:<name>`
   *  slugs). Resolved from config, never from storage: `loadClient` intercepts
   *  the prefix ahead of the DB, `listClients` appends their summaries, and the
   *  client CRUD surface rejects the namespace. Empty/omitted on hosts that
   *  ship no first-party apps. */
  readonly firstPartyClients?: readonly FirstPartyOAuthClientConfig[];
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

/** Order-preserving de-duplication of a scope list. */
const dedupeScopes = (scopes: readonly string[]): readonly string[] => [...new Set(scopes)];

const intersectScopes = (
  requested: readonly string[],
  supported: readonly string[] | undefined,
): readonly string[] => {
  if (!supported || supported.length === 0) return requested;
  const supportedSet = new Set(supported);
  return requested.filter((scope) => supportedSet.has(scope));
};

const recordedOAuthScope = (
  token: OAuth2TokenResponse,
  requestedScopes: readonly string[],
): string | null => {
  if (token.scope == null) return requestedScopes.join(" ") || null;

  const granted = token.scope.split(/\s+/).filter(Boolean);
  const coveredByRefreshToken =
    token.refresh_token && requestedScopes.includes("offline_access") ? ["offline_access"] : [];
  const recorded = dedupeScopes([...granted, ...coveredByRefreshToken]);
  return recorded.join(" ") || null;
};

const OAUTH_SCOPE_ALIASES: Readonly<Record<string, string>> = {
  "https://www.googleapis.com/auth/userinfo.email": "email",
  "https://www.googleapis.com/auth/userinfo.profile": "profile",
};

const informationalOAuthScopes = new Set(["openid", "email", "profile", "offline_access"]);

/** Canonicalize a scope for granted-vs-requested comparison. Microsoft's token
 *  endpoint returns Graph scopes fully qualified
 *  (`https://graph.microsoft.com/Mail.ReadWrite`) even when the request used
 *  the short form, so resource-URI prefixes are stripped down to the scope's
 *  final path segment before comparing. */
const canonicalOAuthScope = (scope: string): string => {
  const aliased = OAUTH_SCOPE_ALIASES[scope];
  if (aliased) return aliased;
  if (/^https?:\/\/graph\.microsoft\.(com|us|de)\//i.test(scope)) {
    return scope.slice(scope.lastIndexOf("/") + 1);
  }
  return scope;
};

/** `.default` is a request-time meta-scope (Microsoft expands it server-side
 *  and never echoes it in the granted scope), so it can never be "missing". */
const isMetaOAuthScope = (scope: string): boolean => scope.toLowerCase().endsWith("/.default");

const normalizedOAuthScopeSet = (scopes: readonly string[]): ReadonlySet<string> =>
  new Set(scopes.map((scope) => canonicalOAuthScope(scope.trim())).filter(Boolean));

export const missingGrantedOAuthScopes = (
  requestedScopes: readonly string[],
  recordedScope: string | null,
): readonly string[] => {
  const granted = normalizedOAuthScopeSet(recordedScope?.split(/\s+/).filter(Boolean) ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of requestedScopes) {
    const trimmed = raw.trim();
    if (isMetaOAuthScope(trimmed)) continue;
    const scope = canonicalOAuthScope(trimmed);
    if (scope.length === 0 || informationalOAuthScopes.has(scope) || seen.has(scope)) continue;
    seen.add(scope);
    if (!granted.has(scope)) out.push(scope);
  }
  return out;
};

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
  grant === "client_credentials" || grant === "authorization_code" || grant === "id_jag"
    ? grant
    : null;

const canonicalDcrIssuer = (
  issuer: string | null | undefined,
  registrationEndpoint: string,
): string | null => {
  const discovered = canonicalIssuerUrl(issuer);
  if (discovered !== null) return discovered;
  const endpoint = parseUrl(registrationEndpoint);
  return endpoint === null ? null : endpoint.origin;
};

const issuerOrigin = (issuer: string): string | null => parseUrl(issuer)?.origin ?? null;

const issuerIsOriginOnly = (issuer: string): boolean => issuerOrigin(issuer) === issuer;

const dcrIssuerMatches = (rowIssuer: string, inputIssuer: string | null): boolean =>
  inputIssuer !== null &&
  (rowIssuer === inputIssuer ||
    (issuerIsOriginOnly(inputIssuer) && issuerOrigin(rowIssuer) === inputIssuer));

const slugifyOAuthKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const shortStableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const dcrClientSlug = (
  issuer: string | null,
  resource: string | null,
  fallback: OAuthClientSlug,
): OAuthClientSlug => {
  if (issuer === null) return fallback;
  const issuerHost = hostOfUrl(issuer);
  if (issuerHost === null) return fallback;
  const base = `dcr-${slugifyOAuthKey(issuerHost) || "authorization-server"}`;
  if (resource === null) return OAuthClientSlug.make(base);
  const resourceUrl = parseUrl(resource);
  const resourceSource =
    resourceUrl === null ? resource : `${resourceUrl.host}${resourceUrl.pathname}`;
  const resourcePart = slugifyOAuthKey(resourceSource).slice(0, 60) || "resource";
  return OAuthClientSlug.make(`${base}-${resourcePart}-${shortStableHash(resource)}`.slice(0, 240));
};

/** Dedupe a freshly-minted DCR slug against slugs already held by an owner's
 *  DCR candidates, appending `-2`, `-3`, … so a new client never collides with
 *  (and clobbers, via createClient's delete-then-create) an existing one. */
const uniqueDcrSlug = (slug: OAuthClientSlug, taken: ReadonlySet<string>): OAuthClientSlug => {
  const base = String(slug);
  if (!taken.has(base)) return slug;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return OAuthClientSlug.make(`${base}-${suffix}`);
};

const parseOAuthClientOrigin = (row: {
  readonly slug?: unknown;
  readonly grant?: unknown;
  readonly resource?: unknown;
  readonly origin_kind?: unknown;
  readonly origin_integration?: unknown;
}): OAuthClientOrigin => {
  // Shared DCR classification (explicit origin_kind OR the legacy MCP-shaped
  // heuristic) lives in `oauth-gc` so the runtime and the GC/backfill
  // migrations agree exactly on what counts as a DCR row.
  if (!isDcrClassifiedRow(row)) {
    return {
      kind: "manual",
      integration:
        row.origin_integration == null
          ? null
          : IntegrationSlug.make(String(row.origin_integration)),
    };
  }
  // An explicit-origin DCR row carries its requesting integration; a
  // heuristic-classified legacy row (null origin_kind) has none.
  return {
    kind: "dynamic_client_registration",
    integration:
      row.origin_kind === "dynamic_client_registration" && row.origin_integration != null
        ? IntegrationSlug.make(String(row.origin_integration))
        : null,
  };
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

const oauthMetadataMatchesClient = (
  client: Pick<LoadedOAuthClient, "authorizationUrl" | "tokenUrl">,
  metadata: OAuthAuthorizationServerMetadata,
): boolean =>
  canonicalUrlString(metadata.authorization_endpoint) ===
    canonicalUrlString(client.authorizationUrl) &&
  canonicalUrlString(metadata.token_endpoint) === canonicalUrlString(client.tokenUrl);

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

/** Resolve a config-declared first-party app to the loaded-client shape the
 *  flow/refresh paths consume. First-party apps are authorization_code only:
 *  client_credentials mints machine tokens under the OPERATOR's app identity,
 *  which must never be shared across tenants. */
export const loadedFirstPartyClient = (
  config: FirstPartyOAuthClientConfig,
): {
  readonly slug: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly grant: OAuthGrant;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly resource: string | null;
} => ({
  slug: String(firstPartyOAuthClientSlug(config.name)),
  authorizationUrl: config.authorizationUrl,
  tokenUrl: config.tokenUrl,
  grant: "authorization_code",
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  resource: config.resource ?? null,
});

export const makeOAuthService = (deps: OAuthServiceDeps): OAuthService => {
  const httpClientLayer = deps.httpClientLayer ?? FetchHttpClient.layer;
  const fetch = deps.fetch;
  // Config-declared first-party apps, keyed by their prefixed slug. Config is
  // the source of truth — no row exists, so every stored-row path (CRUD, GC)
  // is bypassed by construction, and rotating a secret is an env change.
  const firstPartyBySlug = new Map(
    (deps.firstPartyClients ?? []).map((client) => [
      String(firstPartyOAuthClientSlug(client.name)),
      client,
    ]),
  );
  // EXPLICIT — no localhost default. `null` means this executor has no OAuth
  // callback; redirect-requiring flows fail loudly via `requireRedirectUri`.
  const redirectUri = deps.redirectUri;
  const discoveryOptions = { endpointUrlPolicy: deps.endpointUrlPolicy };

  // -------------------------------------------------------------------------
  // Enterprise-managed rollout seam.
  //
  // ROLLOUT SEMANTIC, stated once here because it is the whole reason the gate
  // sits where it does: the gate answers "may this connect attempt the
  // enterprise-managed path", and nothing else. It runs once, before discovery,
  // so a withheld verdict costs no round trip and spends no identity assertion.
  // The verdict it produces is then FROZEN onto the connection
  // (`ENTERPRISE_MANAGED_PROVIDER_STATE_KEY`), and the credential-refresh path
  // reads that state instead of re-asking. Turning the flag off therefore stops
  // new enterprise-managed connects and leaves every existing one renewing — no
  // stranded connections, no silent downgrade, and no third-party network
  // dependency anywhere in credential resolution.
  // -------------------------------------------------------------------------
  const rollout = deps.enterpriseManagedRollout;

  /** The gate's verdict, or "enabled" when no host injected a gate. */
  const decideEnterpriseManagedRollout = (
    context: EnterpriseManagedRolloutContext,
  ): Effect.Effect<EnterpriseManagedRolloutDecision> =>
    rollout === undefined
      ? Effect.succeed(ENTERPRISE_MANAGED_ROLLOUT_ENABLED)
      : rollout.decide(context);

  /** Best-effort rollout observation. Failures AND defects are discarded here,
   *  so no implementation of `record` can fail a connect or change its outcome;
   *  keeping it off the critical path is the host's side of the contract.
   *  Mirrors how `afterCommit` treats `onIntegrationChange`. */
  const recordEnterpriseManagedRollout = (
    event: EnterpriseManagedRolloutEvent,
  ): Effect.Effect<void> =>
    rollout === undefined
      ? Effect.void
      : rollout.record(event).pipe(Effect.ignoreCause({ log: false }));

  const filterAuthorizationCodeScopes = (
    client: LoadedOAuthClient,
    requestedScopes: readonly string[],
  ): Effect.Effect<readonly string[], never> =>
    Effect.gen(function* () {
      if (requestedScopes.length === 0) return requestedScopes;
      const resource = client.resource
        ? yield* discoverProtectedResourceMetadata(client.resource, discoveryOptions).pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.provide(httpClientLayer),
          )
        : null;
      const issuer =
        resource?.metadata.authorization_servers?.[0] ?? new URL(client.authorizationUrl).origin;
      const as = yield* discoverAuthorizationServerMetadata(issuer, discoveryOptions).pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.provide(httpClientLayer),
      );
      if (!as || !oauthMetadataMatchesClient(client, as.metadata)) return requestedScopes;
      return intersectScopes(requestedScopes, as.metadata.scopes_supported);
    }).pipe(Effect.catch(() => Effect.succeed(requestedScopes)));

  // Caps on server-controlled discovery input — a hostile or buggy server must
  // not be able to hang `oauth.start` or overflow the authorize URL.
  const MAX_DISCOVERY_AUTH_SERVERS = 3; // AS-failover lists are tiny in practice
  const MAX_DISCOVERED_SCOPES = 100; // far beyond any realistic authorization template
  const capScopes = (scopes: readonly string[]): readonly string[] =>
    dedupeScopes(scopes).slice(0, MAX_DISCOVERED_SCOPES);

  // Bound a whole discovery sequence (PRM + up to MAX_DISCOVERY_AUTH_SERVERS AS
  // fetches, each with its own request timeout). 30s is larger than a single
  // request timeout so it bounds the sequence, not a slow-but-valid request.
  const withDiscoverySequenceTimeout = <A>(
    sequence: Effect.Effect<A, OAuthDiscoveryError>,
    message: string,
  ): Effect.Effect<A, OAuthDiscoveryError> =>
    sequence.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () => Effect.fail(new OAuthDiscoveryError({ message, cause: "timeout" })),
      }),
    );

  /** Probe, in order, the authorization servers a protected resource named, and
   *  return the first whose RFC 8414 metadata both reads cleanly and satisfies
   *  `accept`. Any AS we cannot read clean metadata from — unreachable, 404,
   *  malformed, or issuer-mismatched — contributes nothing and we move on
   *  (mirroring the dynamic-registration discovery path). We never probe an
   *  arbitrary URL: only the hosts the resource itself named, already capped by
   *  the caller because that list is server-controlled. */
  const firstReadableAuthorizationServer = (
    issuers: readonly string[],
    accept: (metadata: OAuthAuthorizationServerMetadata) => boolean,
  ): Effect.Effect<OAuthAuthorizationServerMetadata | null> =>
    Effect.gen(function* () {
      const discoveryOptions = { endpointUrlPolicy: deps.endpointUrlPolicy, httpClientLayer };
      for (const issuer of issuers) {
        const authServer = yield* discoverAuthorizationServerMetadata(
          issuer,
          discoveryOptions,
        ).pipe(Effect.catchTag("OAuthDiscoveryError", () => Effect.succeed(null)));
        if (authServer && accept(authServer.metadata)) return authServer.metadata;
      }
      return null;
    });

  /** The authorization servers a protected resource names, capped: the list is
   *  server-controlled and a hostile or buggy server must not be able to make
   *  us walk an unbounded number of hosts. */
  const authorizationServerIssuersFor = (
    protectedResource: {
      readonly metadata: { readonly authorization_servers?: readonly string[] };
    } | null,
  ): readonly string[] =>
    (protectedResource?.metadata.authorization_servers ?? []).slice(0, MAX_DISCOVERY_AUTH_SERVERS);

  // Discover the scopes to request when the integration declares none — only
  // reached for integrations that opt in (MCP-style). The resource's own RFC
  // 9728 `scopes_supported` is authoritative when present, even when empty (§2
  // defines the field; §7.2 cautions against requesting more than it lists).
  // Only when the resource is SILENT do we read the scopes advertised by the
  // authorization servers it NAMES (RFC 8414) — we never probe arbitrary URLs.
  const discoverScopesForResource = (
    resource: string | null,
  ): Effect.Effect<readonly string[], OAuthDiscoveryError> =>
    Effect.gen(function* () {
      if (resource == null) {
        return yield* new OAuthDiscoveryError({
          message: "Cannot discover OAuth scopes: the client has no resource configured",
        });
      }
      // `httpClientLayer` flows through `options` so discovery uses the host's
      // configured client (discovery self-provides from `options.httpClientLayer`).
      const discoveryOptions = { endpointUrlPolicy: deps.endpointUrlPolicy, httpClientLayer };

      const protectedResource = yield* discoverProtectedResourceMetadata(
        resource,
        discoveryOptions,
      );
      const resourceScopes = protectedResource?.metadata.scopes_supported;
      if (resourceScopes !== undefined) return capScopes(resourceScopes);

      // The resource is silent on scopes — read them from the authorization
      // servers it names, in order. An advertised list is authoritative even
      // when empty, so "advertises scopes at all" is the acceptance test. If
      // none do we request none and let the AS apply its defaults (RFC 8414
      // metadata is optional, so its absence is not a failure).
      const authServer = yield* firstReadableAuthorizationServer(
        authorizationServerIssuersFor(protectedResource),
        (metadata) => metadata.scopes_supported !== undefined,
      );
      return authServer?.scopes_supported === undefined
        ? []
        : capScopes(authServer.scopes_supported);
    }).pipe((sequence) =>
      withDiscoverySequenceTimeout(sequence, "OAuth scope discovery timed out"),
    );

  /** The RFC 8414 metadata of the authorization server that protects `resource`.
   *  Enterprise-managed authorization needs two facts that live ONLY here: the
   *  issuer identifier the ID-JAG must name as its audience, and whether the
   *  server implements the ID-JAG grant profile at all. Same discovery order as
   *  scope discovery — the protected resource names its authorization servers;
   *  we never probe an arbitrary URL. */
  const discoverResourceAuthorizationServer = (
    resource: string | null,
  ): Effect.Effect<OAuthAuthorizationServerMetadata, OAuthDiscoveryError> =>
    Effect.gen(function* () {
      if (resource == null) {
        return yield* new OAuthDiscoveryError({
          message:
            "Cannot discover the authorization server: the OAuth app has no resource configured",
        });
      }
      const protectedResource = yield* discoverProtectedResourceMetadata(resource, {
        endpointUrlPolicy: deps.endpointUrlPolicy,
        httpClientLayer,
      });
      const issuers = authorizationServerIssuersFor(protectedResource);
      const metadata = yield* firstReadableAuthorizationServer(issuers, () => true);
      if (metadata) return metadata;
      return yield* new OAuthDiscoveryError({
        message: `No authorization-server metadata found for ${resource}${
          issuers.length > 0 ? ` (tried: ${issuers.join(", ")})` : ""
        }`,
      });
    }).pipe((sequence) =>
      withDiscoverySequenceTimeout(sequence, "OAuth authorization-server discovery timed out"),
    );

  // -----------------------------------------------------------------------
  // createClient — write the oauth_client row.
  // -----------------------------------------------------------------------
  const createClient = (
    input: CreateOAuthClientInput,
  ): Effect.Effect<OAuthClientSlug, OrgWriteDeniedError | StorageFailure> =>
    Effect.gen(function* () {
      // The `first-party:` namespace is reserved for config-declared apps — a
      // stored row under it would be shadowed by (or worse, impersonate) the
      // host's own app.
      if (isFirstPartyOAuthClientSlug(String(input.slug))) {
        return yield* new StorageError({
          message: `OAuth client slug "${String(input.slug)}" uses the reserved first-party namespace.`,
          cause: undefined,
        });
      }
      yield* deps.guardOrgWrite(input.owner);
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

      yield* deps.fuma.transaction(
        Effect.gen(function* () {
          const existing = yield* deps.fuma.use("oauth_client.findExisting", (db) =>
            looseDb(db).findFirst("oauth_client", {
              where: (b: any) =>
                b.and(b("owner", "=", input.owner), b("slug", "=", String(input.slug))),
            }),
          );
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
                input.origin?.integration == null ? null : String(input.origin.integration),
              origin_issuer:
                input.origin?.kind === "dynamic_client_registration"
                  ? (canonicalIssuerUrl(input.originIssuer) ?? null)
                  : null,
              origin_redirect_uri:
                input.origin?.kind === "dynamic_client_registration"
                  ? (input.originRedirectUri ?? null)
                  : null,
              created_at: now,
            }),
          );
          yield* deps.recordAuditEvent({
            action: existing ? "updated" : "created",
            resourceType: "oauth_client",
            resourceOwner: input.owner,
            resourceId: String(input.slug),
          });
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
  const removeClient = (
    owner: Owner,
    slug: OAuthClientSlug,
  ): Effect.Effect<void, OrgWriteDeniedError | StorageFailure> =>
    Effect.gen(function* () {
      // Config-declared apps have no row to remove; removing one is an env
      // change on the host, not a storage operation. Fail loudly rather than
      // returning a success that changed nothing.
      if (isFirstPartyOAuthClientSlug(String(slug))) {
        return yield* new StorageError({
          message: `OAuth client "${String(slug)}" is a first-party app declared in host config; it cannot be removed through this surface.`,
          cause: undefined,
        });
      }
      yield* deps.guardOrgWrite(owner);
      const removed = yield* deps.fuma.transaction(
        Effect.gen(function* () {
          const existing = yield* deps.fuma.use("oauth_client.findForRemoval", (db) =>
            looseDb(db).findFirst("oauth_client", {
              where: (b: any) => b.and(b("owner", "=", owner), b("slug", "=", String(slug))),
            }),
          );
          yield* deps.fuma
            .use("oauth_client.delete", (db) =>
              looseDb(db).deleteMany("oauth_client", {
                where: (b: any) => b.and(b("owner", "=", owner), b("slug", "=", String(slug))),
              }),
            )
            .pipe(Effect.asVoid);
          if (existing) {
            yield* deps.recordAuditEvent({
              action: "removed",
              resourceType: "oauth_client",
              resourceOwner: owner,
              resourceId: String(slug),
            });
          }
          return existing !== null;
        }),
      );
      // Best-effort: drop the secret from the provider so it isn't orphaned.
      const provider = deps.defaultWritableProvider();
      if (removed && provider?.delete) {
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

  type DcrReuseCandidate = {
    readonly slug: OAuthClientSlug;
    readonly resource: string | null;
    /** Redirect URI the candidate registered with the AS; null for rows
     *  predating the column (treated as matching any flow callback). */
    readonly redirectUri: string | null;
  };

  // `oauth_client.created_at` is a date column that surfaces as a Date, an ISO
  // string, or an epoch number depending on the storage backend. Normalize to
  // epoch ms for deterministic oldest-first ordering; an unparseable/missing
  // value sorts as 0 (oldest), so slug then breaks the tie stably.
  const candidateCreatedAt = (value: unknown): number => {
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
  };

  const dcrCandidatesForIssuer = (
    owner: Owner,
    issuer: string | null,
  ): Effect.Effect<readonly DcrReuseCandidate[], StorageFailure> =>
    deps.fuma
      .use("oauth_client.findMany", (db) =>
        looseDb(db).findMany("oauth_client", {
          where: (b: any) => b("owner", "=", owner),
        }),
      )
      .pipe(
        Effect.map((rows) => {
          const matches = rows.flatMap(
            (row): readonly (DcrReuseCandidate & { readonly createdAt: number })[] => {
              if (parseOAuthClientOrigin(row).kind !== "dynamic_client_registration") return [];
              // A candidate matches only via a non-null, canonicalized stored
              // issuer. The GC migration backfills origin_issuer on every
              // surviving DCR row, so post-migration a null-issuer row is a
              // transient (unmigrated) row; skipping it just mints one duplicate
              // the migration then GCs, rather than reusing on a fuzzy token-host
              // guess.
              const rowIssuer =
                row.origin_issuer == null ? null : canonicalIssuerUrl(String(row.origin_issuer));
              const issuerMatches = rowIssuer !== null && dcrIssuerMatches(rowIssuer, issuer);
              if (!issuerMatches) return [];
              return [
                {
                  slug: OAuthClientSlug.make(String(row.slug)),
                  resource: row.resource == null ? null : String(row.resource),
                  redirectUri:
                    row.origin_redirect_uri == null ? null : String(row.origin_redirect_uri),
                  createdAt: candidateCreatedAt(row.created_at),
                },
              ];
            },
          );
          // Deterministic reuse order: oldest first, slug as a stable tiebreak
          // when timestamps collide or are missing. Without this, which of
          // several live duplicates sharing an (owner, issuer) gets reused is
          // whatever order the storage backend returned rows in — the reuse
          // pick must be stable across boots and backends.
          return [...matches]
            .sort(
              (a, b) =>
                a.createdAt - b.createdAt || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
            )
            .map(
              ({ slug, resource, redirectUri }): DcrReuseCandidate => ({
                slug,
                resource,
                redirectUri,
              }),
            );
        }),
      );

  const decideDcrClientReuse = (
    input: RegisterDynamicClientInput,
    issuer: string | null,
    flowRedirectUri: string | null,
  ): Effect.Effect<
    {
      readonly existingSlug: OAuthClientSlug | null;
      readonly registrationSlug: OAuthClientSlug;
    },
    StorageFailure
  > =>
    Effect.gen(function* () {
      const candidates = yield* dcrCandidatesForIssuer(input.owner, issuer);
      const resource = input.resource ?? null;
      // A candidate is reusable only when the callback it registered with the
      // AS still matches the current flow's callback — strict servers reject an
      // authorize request whose redirect_uri differs from the registration
      // (e.g. the callback origin changed after a sandbox was recreated while
      // the persisted client survived). A null stored redirect is a legacy row
      // predating the column: treated as matching so an upgrade doesn't
      // re-register every client whose callback never changed. A null FLOW
      // redirect has nothing to compare against, so it also reuses — the only
      // alternative is a fresh registration, which the missing-redirectUri
      // guard would fail.
      const redirectMatches = (candidate: DcrReuseCandidate): boolean =>
        candidate.redirectUri === null ||
        flowRedirectUri === null ||
        candidate.redirectUri === flowRedirectUri;
      // A fresh registration must never take a slug an existing candidate
      // holds: `createClient` deletes any colliding (owner, slug) row first,
      // which would clobber a client that live connections still refresh
      // through (a redirect-mismatched client stays valid for refresh — the
      // token grant doesn't involve the redirect URI).
      const takenSlugs = new Set(candidates.map((client) => String(client.slug)));
      if (resource !== null) {
        const matchingResource = candidates.find((client) => client.resource === resource);
        if (matchingResource && redirectMatches(matchingResource)) {
          return { existingSlug: matchingResource.slug, registrationSlug: matchingResource.slug };
        }
        const slug = uniqueDcrSlug(
          dcrClientSlug(issuer, candidates.length > 0 ? resource : null, input.slug),
          takenSlugs,
        );
        return {
          existingSlug: null,
          registrationSlug: slug,
        };
      }

      // Resource-less request: only reuse a resource-LESS candidate. A client
      // minted for a specific RFC 8707 resource must NOT be reused for a
      // resource-less flow (its tokens are bound to that resource), so when only
      // resource-scoped candidates exist we register a fresh resource-less client
      // rather than silently borrowing one (the old `?? candidates[0]` bug).
      const reusable = candidates.find(
        (client) => client.resource === null && redirectMatches(client),
      );
      if (reusable) return { existingSlug: reusable.slug, registrationSlug: reusable.slug };
      // Fresh resource-less client. Its slug is the bare `dcr-<host>` base, but
      // the FIRST resource-scoped registration for an issuer also takes that base
      // (dcrClientSlug only suffixes once candidates exist) — the takenSlugs
      // dedupe keeps the resource-less client on its own row.
      const slug = uniqueDcrSlug(dcrClientSlug(issuer, null, input.slug), takenSlugs);
      return { existingSlug: null, registrationSlug: slug };
    });

  const registerDynamicClient = (
    input: RegisterDynamicClientInput,
  ): Effect.Effect<
    OAuthClientSlug,
    OAuthRegisterDynamicError | OrgWriteDeniedError | StorageFailure
  > =>
    Effect.gen(function* () {
      const issuer = canonicalDcrIssuer(input.issuer, input.registrationEndpoint);
      // Resolved before the reuse decision: a persisted client registered with
      // a DIFFERENT callback must not be reused (strict servers 400 the
      // authorize request), so the reuse lookup compares against this value.
      const flowRedirectUri = input.redirectUri ?? redirectUri ?? null;
      const reuse = yield* decideDcrClientReuse(input, issuer, flowRedirectUri);
      if (reuse.existingSlug !== null) return reuse.existingSlug;

      const slug = reuse.registrationSlug;
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
        Effect.mapError((cause) => {
          // Some authorization servers (Vercel, and others that follow RFC 8252
          // strictly) reject anonymous Dynamic Client Registration unless the
          // redirect URI is loopback (http://localhost or http://127.0.0.1).
          // Executor registers its browser origin, so any hosted, tailnet, or
          // LAN origin trips `invalid_redirect_uri`. Turn that opaque RFC code
          // into guidance the user can act on instead of the raw error.
          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message`
          const rawMessage = cause.message;
          const message =
            cause.error === "invalid_redirect_uri" && !isLoopbackHttpUrl(flowRedirectUri)
              ? `Automatic OAuth setup failed: this server only approves loopback redirect ` +
                `URLs (http://localhost or http://127.0.0.1) for automatic registration, but ` +
                `Executor is using ${flowRedirectUri}. Register an OAuth app manually with that ` +
                `redirect URL approved by the server, or run Executor on http://localhost.`
              : `Dynamic Client Registration failed: ${rawMessage}`;
          return new OAuthRegisterDynamicError({ message });
        }),
      );

      // Persist the minted client. DCR-minted public clients have no secret; we
      // store "" so the PKCE-only token exchange omits `client_secret`.
      // Confidential DCR clients keep the returned secret in the credential
      // provider. The persisted grant is interactive authorization_code.
      // `input.scopes` was already sent to the AS at registration above; the
      // stored client carries no scope set (the integration drives requests).
      yield* createClient({
        owner: input.owner,
        slug,
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
        originIssuer: issuer,
        originRedirectUri: flowRedirectUri,
      });
      return slug;
    });

  // -----------------------------------------------------------------------
  // listClients — metadata-only summaries of every client the caller can see.
  // The owner policy on `oauth_client` already narrows `findMany` to the
  // tenant's org rows + this subject's own user rows, so no explicit filter is
  // needed. The `client_secret` column is deliberately never projected.
  // -----------------------------------------------------------------------
  const listClients = (): Effect.Effect<readonly OAuthClientSummary[], StorageFailure> => {
    // First-party apps lead the list: config-resolved, visible to every caller,
    // and projected exactly like stored rows — clientId only, never the secret.
    // Owner is reported as "org" (the widest visibility the summary shape can
    // express); the flow itself ignores owner for first-party slugs.
    const firstPartySummaries: readonly OAuthClientSummary[] = [...firstPartyBySlug.values()].map(
      (config) => ({
        owner: "org",
        slug: firstPartyOAuthClientSlug(config.name),
        grant: "authorization_code",
        authorizationUrl: config.authorizationUrl,
        tokenUrl: config.tokenUrl,
        resource: config.resource ?? null,
        clientId: config.clientId,
        origin: {
          kind: "first_party",
          ...(config.integrations !== undefined ? { integrations: config.integrations } : {}),
          ...(config.allowedScopes !== undefined ? { allowedScopes: config.allowedScopes } : {}),
        },
      }),
    );
    return deps.fuma
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
        Effect.map((stored) => [...firstPartySummaries, ...stored]),
      );
  };

  // -----------------------------------------------------------------------
  // Load an oauth_client row by (owner, slug).
  // -----------------------------------------------------------------------
  const loadClient = (
    owner: Owner,
    slug: OAuthClientSlug,
  ): Effect.Effect<LoadedOAuthClient | null, StorageFailure> => {
    // First-party apps resolve from config, never storage. Owner is irrelevant:
    // the app belongs to the DEPLOYMENT, and visibility policy has nothing to
    // narrow — only the minted connection (and its tokens) is owner-scoped.
    if (isFirstPartyOAuthClientSlug(String(slug))) {
      const config = firstPartyBySlug.get(String(slug));
      return Effect.succeed(config ? loadedFirstPartyClient(config) : null);
    }
    return deps.fuma
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
  };

  // -----------------------------------------------------------------------
  // start — begin a flow through a client to mint a connection.
  // -----------------------------------------------------------------------
  const start = (
    input: OAuthStartInput,
  ): Effect.Effect<ConnectResult, OAuthStartError | OrgWriteDeniedError | StorageFailure> =>
    Effect.gen(function* () {
      // Gate before any session row or upstream exchange: minting a Workspace
      // connection (including a reconnect that would replace its credential)
      // is a workspace-level change. Personal connections remain member-owned.
      yield* deps.guardOrgWrite(input.owner);
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
      // First-party apps are deployment-owned, outside the owner lattice
      // entirely, so the rule does not apply to them.
      const firstPartyFlow = isFirstPartyOAuthClientSlug(String(input.client));
      yield* Effect.annotateCurrentSpan({
        "executor.oauth.client_first_party": firstPartyFlow,
      });
      if (!firstPartyFlow && input.owner === "org" && input.clientOwner === "user") {
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

      // Normalize the name the same way the mint stores it, so the free-name
      // guard below compares against the exact stored form.
      const requestedName = connectionIdentifier(String(input.name));
      // newConnection: resolve the requested name to a FREE one against the
      // stored rows (not a client-side, policy-filtered view), so a second
      // untyped connect mints `personalGmail2` instead of silently re-minting
      // the first account's row. Reconnects omit the flag and keep targeting
      // their existing row. Bounded: a pathological owner with 1000 same-named
      // connections fails loudly rather than scanning forever.
      let name = requestedName;
      if (input.newConnection === true) {
        let suffix = 2;
        while (
          yield* deps.connectionNameTaken({
            owner: input.owner,
            integration: input.integration,
            name,
          })
        ) {
          if (suffix > 1000) {
            return yield* new OAuthStartError({
              message: `No free connection name derivable from ${input.name}.`,
            });
          }
          name = ConnectionName.make(`${String(requestedName)}${suffix}`);
          suffix++;
        }
      }

      // Declared scopes win (driven by the selected auth template). MCP-style
      // integrations declare none and discover them from the client's protected
      // resource / authorization server metadata at connect.
      const scopePolicy = yield* deps
        .resolveOAuthScopePolicy(input.integration, input.template)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OAuthStartError({
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                message: `Failed to resolve OAuth scope policy: ${cause.message}`,
              }),
          ),
        );
      const firstParty = firstPartyFlow ? firstPartyBySlug.get(String(input.client)) : undefined;
      const requestedScopes =
        scopePolicy.kind === "discover"
          ? yield* (() => {
              const discovered = discoverScopesForResource(client.resource).pipe(
                Effect.mapError(
                  (cause) =>
                    new OAuthStartError({
                      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message` field
                      message: `Failed to discover OAuth scopes: ${cause.message}`,
                    }),
                ),
              );
              if (firstParty?.allowedScopes === undefined) return discovered;
              const allowed = new Set(firstParty.allowedScopes);
              return discovered.pipe(
                Effect.map((scopes) => scopes.filter((scope) => allowed.has(scope))),
              );
            })()
          : dedupeScopes(scopePolicy.scopes);

      // An explicitly scope-limited first-party app is an authorization
      // boundary, not picker decoration. Endpoint matching and provider
      // discovery can surface capabilities outside the registered app, so
      // enforce the complete requested set before persisting or redirecting.
      if (firstPartyFlow) {
        if (
          firstParty !== undefined &&
          !firstPartyOAuthClientAllowsScopes(firstParty, requestedScopes)
        ) {
          return yield* new OAuthStartError({
            message: `The built-in OAuth app is not enabled for integration ${input.integration}.`,
          });
        }
      }

      // client_credentials: exchange immediately and mint the connection.
      if (client.grant === "client_credentials") {
        const token = yield* exchangeClientCredentials({
          tokenUrl: client.tokenUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          scopes: requestedScopes,
          resource: client.resource ?? undefined,
          endpointUrlPolicy: deps.endpointUrlPolicy,
          fetch,
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
          { ...input, name },
          client,
          token,
          requestedScopes,
          input.clientOwner,
          // client_credentials has no callback, so no regional rebind applies.
          null,
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

      // Enterprise-managed authorization (draft §4): no browser, no per-server
      // consent — exchange the identity assertion the user already holds. Only
      // an authorization server that does NOT advertise the grant profile falls
      // through to the interactive flow below; an IdP refusal is an enterprise
      // policy decision and stops here, because offering the interactive flow
      // instead would let the user route straight around it.
      if (client.grant === "id_jag") {
        // The rollout gate, consulted ONCE and BEFORE anything else in this
        // branch: before the IdP registration is loaded, before discovery,
        // before a single request leaves the process. A withheld verdict must
        // therefore cost no round trip and spend no identity assertion.
        //
        // Its answer is read exactly here and never again. Once the IdP has
        // ruled, that verdict is final: re-consulting a flag after a denial
        // would turn the flag into an escape hatch around the enterprise
        // control this whole profile exists to enforce.
        const rolloutContext: EnterpriseManagedRolloutContext = {
          userId: deps.subject,
          organizationId: deps.tenant,
          integration: input.integration,
        };
        const rolloutDecision = yield* decideEnterpriseManagedRollout(rolloutContext);
        // Recorded for BOTH arms, so the funnel below it has a denominator.
        yield* recordEnterpriseManagedRollout({
          kind: "attempted",
          context: rolloutContext,
          decision: rolloutDecision,
        });

        if (rolloutDecision.kind === "withheld") {
          // Withheld takes the SAME exit an authorization server that never
          // implemented the profile takes: fall through to the ordinary
          // interactive flow below. There is deliberately no second fallback
          // path to keep in step with the first.
          yield* Effect.annotateCurrentSpan({
            "executor.oauth.enterprise_managed_fallback": true,
            "executor.oauth.enterprise_managed_withheld": rolloutDecision.reason,
          });
        } else {
          const enterprise = input.enterprise;
          if (enterprise === undefined) {
            return yield* new OAuthStartError({
              message:
                "This OAuth app uses enterprise-managed authorization, which requires an enterprise identity provider and an identity assertion on the connect request.",
            });
          }
          const idpClient = yield* loadClient(enterprise.idpClientOwner, enterprise.idpClient);
          if (!idpClient) {
            return yield* new OAuthStartError({
              message: `Enterprise identity provider OAuth client not found: ${enterprise.idpClient}`,
            });
          }
          const metadata = yield* discoverResourceAuthorizationServer(client.resource).pipe(
            Effect.mapError(
              (cause) =>
                new OAuthStartError({
                  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuthDiscoveryError carries a typed `message` field
                  message: `Failed to discover the MCP server's authorization server: ${cause.message}`,
                }),
            ),
          );
          // Resolve the caller's optional assertion type ONCE: the chain sends
          // it and the connection persists it, and those two must not be able
          // to disagree about what was presented.
          const resolvedEnterprise = {
            ...enterprise,
            subjectTokenType: enterprise.subjectTokenType ?? DEFAULT_SUBJECT_TOKEN_TYPE,
          };
          const enterpriseGrant = yield* runEnterpriseManagedAuthorization({
            authorizationServerMetadata: metadata,
            idp: {
              tokenUrl: idpClient.tokenUrl,
              clientId: idpClient.clientId,
              clientSecret: idpClient.clientSecret,
            },
            resourceAuthorizationServer: {
              clientId: client.clientId,
              clientSecret: client.clientSecret,
            },
            subjectToken: resolvedEnterprise.subjectToken,
            subjectTokenType: resolvedEnterprise.subjectTokenType,
            resource: client.resource,
            scopes: requestedScopes,
            endpointUrlPolicy: deps.endpointUrlPolicy,
            // No `httpClientLayer` here, deliberately: like every other token
            // request in this service, the ID-JAG chain runs through oauth4webapi
            // on the configured `fetch`, not Effect's HttpClient. Only discovery
            // speaks HttpClient. Providing the layer here would claim otherwise.
            fetch,
          }).pipe(
            Effect.map((grant) => ({ supported: true as const, grant })),
            // Only the unsupported-profile failure is recoverable; every other
            // tag reaches the caller as a start error carrying its own verdict.
            Effect.catchTag("EmaGrantProfileUnsupported", () =>
              Effect.succeed({ supported: false as const }),
            ),
            Effect.mapError(startErrorFromEnterpriseManaged),
            // OBSERVATION ONLY. This taps the denial on its way out; it does not
            // recover it, and no branch below reads the rollout decision again.
            Effect.tapError((failure) =>
              failure.blockedByAdmin === true
                ? recordEnterpriseManagedRollout({
                    kind: "blocked-by-admin",
                    context: rolloutContext,
                    decision: rolloutDecision,
                    oauthErrorCode: failure.oauthErrorCode,
                  })
                : Effect.void,
            ),
          );
          if (enterpriseGrant.supported) {
            const connection = yield* mintEnterpriseManagedConnection(
              { ...input, name },
              client,
              input.clientOwner,
              enterpriseGrant.grant,
              resolvedEnterprise,
              metadata.issuer,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new OAuthStartError({
                    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: StorageFailure carries a typed `message` field
                    message: `Failed to mint OAuth connection: ${cause.message}`,
                  }),
              ),
            );
            yield* recordEnterpriseManagedRollout({
              kind: "connected",
              context: rolloutContext,
              decision: rolloutDecision,
            });
            return { status: "connected", connection } as const;
          }
          yield* Effect.annotateCurrentSpan({
            "executor.oauth.enterprise_managed_fallback": true,
          });
        }
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
      // Prune stale DECLARED scopes against the AS's advertised set, but leave
      // resource-discovered scopes untouched: an RFC 9728 `scopes_supported`
      // list is already authoritative (§7.2) and must not be re-narrowed by a
      // divergent authorization server.
      const authorizationRequestedScopes =
        firstParty?.authorizationScopes !== undefined
          ? dedupeScopes(firstParty.authorizationScopes)
          : scopePolicy.kind === "discover"
            ? requestedScopes
            : yield* filterAuthorizationCodeScopes(client, requestedScopes);

      // authorization_code: persist a session + build the authorize URL.
      const verifier = createPkceCodeVerifier();
      const challenge = yield* Effect.promise(() => createPkceCodeChallenge(verifier));
      const state = OAuthState.make(createOAuthState());
      const providerState = encodeOAuthCallbackState({
        state: String(state),
        orgSlug: deps.callbackStateOrgSlug,
      });

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
          name: String(name),
          template: String(input.template),
          redirect_url: flowRedirectUri,
          pkce_verifier: verifier,
          identity_label: input.identityLabel ?? null,
          // Persist the requested scope set (declared ∪ client, filtered to the
          // authorization-code flow) so `complete`'s recorded-scope fallback
          // reflects exactly what was requested when the AS omits `scope`,
          // without re-resolving the integration's declared scopes at completion.
          payload: {
            owner: input.owner,
            clientOwner: input.clientOwner,
            requestedScopes: authorizationRequestedScopes,
          },
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
            scopes: authorizationRequestedScopes,
            state: providerState,
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
        // The scope set `start` requested (the integration's declared or
        // discovered scopes), persisted on the session payload. Drives the
        // recorded-scope fallback when the AS omits `scope`. Missing/legacy
        // payloads fall back to the client's scopes below.
        requestedScopes: requestedScopesFromPayload(sessionRow.payload),
        // The app's owner, recorded by `start` — reload the SAME app at
        // completion by explicit owner (no derivation). Defaults to the session
        // owner for same-owner connects.
        clientOwner:
          clientOwnerFromPayload(sessionRow.payload) ?? (String(sessionRow.owner) as Owner),
      };

      // Annotate as soon as the session resolves the flow's identity, so even
      // a completion that fails at the exchange still says WHOSE connect died.
      yield* Effect.annotateCurrentSpan({
        "executor.integration": String(session.integration),
        "executor.connection": String(session.name),
        "executor.template": String(session.template),
        "executor.oauth.client": String(session.clientSlug),
        "executor.oauth.client_first_party": isFirstPartyOAuthClientSlug(
          String(session.clientSlug),
        ),
      });

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
      if (isFirstPartyOAuthClientSlug(String(session.clientSlug))) {
        const firstParty = firstPartyBySlug.get(String(session.clientSlug));
        if (
          firstParty !== undefined &&
          firstParty.allowedScopes !== undefined &&
          (session.requestedScopes === null ||
            !firstPartyOAuthClientAllowsScopes(firstParty, session.requestedScopes))
        ) {
          return yield* new OAuthCompleteError({
            message: `The built-in OAuth app is no longer enabled for integration ${session.integration}; restart the flow.`,
            restartRequired: true,
          });
        }
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

      // Some authorization servers (Datadog) advertise one region's token
      // endpoint in static metadata but issue codes that only redeem at the
      // org's actual region, signalled back on the callback as `domain`/`site`.
      // Rebind the token host to that region when it is a sibling subdomain of
      // the configured host; otherwise this is a no-op.
      const tokenUrl = rebindTokenEndpointHostToCallbackDomain(
        client.tokenUrl,
        input.callbackDomain,
      );

      const token = yield* exchangeAuthorizationCode({
        tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUrl: session.redirectUrl,
        codeVerifier: session.pkceVerifier,
        code: input.code,
        resource: client.resource ?? undefined,
        endpointUrlPolicy: deps.endpointUrlPolicy,
        fetch,
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
          identityLabel: session.identityLabel ?? null,
        },
        client,
        token,
        // The scopes `start` requested (the integration's declared set), persisted
        // on the session. Empty only for a corrupt/legacy session with no payload.
        session.requestedScopes ?? [],
        session.clientOwner,
        // Persist the regional token endpoint ONLY when it differs from the
        // client's configured one, so refresh redeems against the same region.
        tokenUrl === client.tokenUrl ? null : tokenUrl,
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

      // Everything a "why did this connect fail / where did it go" question
      // needs, none of it secret: slugs, owner scope, and whether the token
      // host was rebound to a regional endpoint (the Datadog multi-site path —
      // a bug there previously shipped and was only diagnosable by hand).
      // Deliberately absent: the code, the PKCE verifier, the token, the
      // callback domain (can embed an org's private site), and identityLabel
      // (resolves to an email).
      yield* Effect.annotateCurrentSpan({
        "executor.oauth.token_host_rebound": tokenUrl !== client.tokenUrl,
      });

      yield* deleteSession(input.state);
      return connection;
    }).pipe(
      Effect.withSpan("executor.oauth.complete", {
        attributes: {
          "executor.oauth.grant": "authorization_code",
          // Same per-customer dimensions as executor.oauth.refresh, so a
          // connect and its later refresh failures group under one tenant.
          "executor.tenant": deps.tenant,
          ...(deps.subject != null ? { "executor.subject": deps.subject } : {}),
        },
      }),
    );

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
    /** The scope set requested at /authorize + /token (the integration's
     *  declared or discovered scopes) — the recorded-scope fallback when the AS
     *  omits `scope`. */
    requestedScopes: readonly string[],
    /** The owner of `client` — persisted so refresh loads it by explicit owner. */
    clientOwner: Owner,
    /** Regional token endpoint override to persist when the code was redeemed
     *  off the client's configured host; null to use the client's token URL. */
    oauthTokenUrl: string | null,
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

      const oauthScope = recordedOAuthScope(token, requestedScopes);
      const missingScopes =
        client.grant === "authorization_code"
          ? missingGrantedOAuthScopes(requestedScopes, oauthScope)
          : [];
      // The freshness facts of this connection AT BIRTH, on the enclosing
      // span (executor.oauth.complete, or the reconnect path's request
      // envelope). Every "why did this connection later go stale" question
      // starts here: a partial grant fails later as oauth_scope_insufficient
      // in an unrelated trace; no refresh token means the first expiry is
      // terminal; no advertised expiry means only the reactive 401 path can
      // ever refresh it. Counts and booleans only — scope VALUES can encode
      // customer resource names on some providers.
      yield* Effect.annotateCurrentSpan({
        "executor.oauth.scope_requested_count": requestedScopes.length,
        "executor.oauth.scope_missing_count": missingScopes.length,
        "executor.oauth.has_refresh_token": token.refresh_token !== undefined,
        "executor.oauth.has_advertised_expiry": typeof token.expires_in === "number",
      });
      return yield* deps.mintOAuthConnection({
        owner: target.owner,
        name: target.name,
        integration: target.integration,
        template: target.template,
        identityLabel: target.identityLabel ?? null,
        // The OIDC account claims travel separately: they may only FILL an
        // empty label, never replace a user-curated one on reconnect.
        derivedIdentityLabel: token.idTokenIdentityLabel ?? null,
        provider: String(provider.key),
        itemId,
        oauthClient: OAuthClientSlug.make(client.slug),
        oauthClientOwner: clientOwner,
        refreshItemId,
        expiresAt: expiresAtFrom(token),
        // Record the granted scope the AS echoed back. Some providers, including
        // Microsoft, issue a refresh token for `offline_access` but omit that
        // non-resource scope from the token `scope` string, so preserve it when
        // the refresh token proves it was granted.
        oauthScope,
        missingOAuthScopes: missingScopes,
        oauthTokenUrl,
      });
    });

  /** Mint a connection from an enterprise-managed grant. Distinct from
   *  `mintFromToken` because the material persisted is different: there is no
   *  refresh token (draft §4.4.3), and the identity assertion takes the refresh
   *  slot — it is exactly the credential that lets renewal run without the
   *  user, which is what that slot means. */
  const mintEnterpriseManagedConnection = (
    target: {
      readonly owner: Owner;
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly identityLabel?: string | null;
    },
    client: LoadedOAuthClient,
    clientOwner: Owner,
    grant: EnterpriseManagedGrant,
    /** The connect request's enterprise inputs with the assertion type already
     *  resolved — the persisted state records what was actually presented, so
     *  it must not re-derive a default the chain might have differed on. */
    enterprise: EnterpriseManagedStartInput & { readonly subjectTokenType: SubjectTokenType },
    /** The Resource Authorization Server's issuer identifier, as discovered. */
    audience: string,
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
      yield* provider.set(ProviderItemId.make(itemId), grant.token.access_token);
      const subjectTokenItemId = refreshItemIdFor(itemId);
      yield* provider.set(ProviderItemId.make(subjectTokenItemId), enterprise.subjectToken);

      yield* Effect.annotateCurrentSpan({
        "executor.oauth.has_advertised_expiry": typeof grant.token.expires_in === "number",
        "executor.oauth.enterprise_managed": true,
      });
      return yield* deps.mintOAuthConnection({
        owner: target.owner,
        name: target.name,
        integration: target.integration,
        template: target.template,
        identityLabel: target.identityLabel ?? null,
        derivedIdentityLabel: grant.token.idTokenIdentityLabel ?? null,
        provider: String(provider.key),
        itemId,
        oauthClient: OAuthClientSlug.make(client.slug),
        oauthClientOwner: clientOwner,
        refreshItemId: subjectTokenItemId,
        expiresAt: expiresAtFrom(grant.token),
        oauthScope: grant.scope,
        enterpriseManaged: {
          idpClient: enterprise.idpClient,
          idpClientOwner: enterprise.idpClientOwner,
          audience,
          subjectTokenType: enterprise.subjectTokenType,
        },
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
        issuer: as.metadata.issuer,
        authorizationUrl: as.metadata.authorization_endpoint,
        tokenUrl: as.metadata.token_endpoint,
        resource: resource?.metadata.resource ?? null,
        // Prefer the resource's own RFC 9728 scopes (authoritative, even when
        // empty); fall back to the authorization server's list only when PRM is
        // silent. For a spec-compliant MCP server (one that publishes PRM) this
        // matches what `oauth.start` discovers. The AS fallback is a best-effort
        // hint for the registration form on servers that omit PRM — where
        // `oauth.start` requests none — so the two can differ for those.
        scopesSupported: resource?.metadata.scopes_supported ?? as.metadata.scopes_supported,
        registrationEndpoint: as.metadata.registration_endpoint ?? null,
        tokenEndpointAuthMethodsSupported: as.metadata.token_endpoint_auth_methods_supported,
        clientIdMetadataDocumentSupported:
          as.metadata.client_id_metadata_document_supported === true,
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
