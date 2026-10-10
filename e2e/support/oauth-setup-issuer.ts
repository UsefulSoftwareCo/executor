/** A scoped external OAuth issuer for setup checks; Executor still uses its real HTTP and storage paths. */
import { createServer } from "node:http";
import { Socket } from "node:net";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { tokenRequestParameters } from "./client-credentials-issuer.ts";

type TokenAuth = "client_secret_basic" | "client_secret_post" | "none";
type SecretAuth = Exclude<TokenAuth, "none">;

/** The members a standard token response carries; absent members were not issued. */
export type IssuedTokens = {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
};
export type TokenShape = (tokens: IssuedTokens, refreshing: boolean) => object;
/** A token request as the service received it, for an error page that repeats it. */
export type ReceivedTokenRequest = {
  readonly body: string;
  readonly authorization: string | undefined;
};

/** A JSON-RPC request or notification to the served MCP server. */
const McpMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});

/**
 * The port the next issuer listens on. Zero, the default, lets the system assign one; a Cloud
 * scenario binds the port its local Cloud's operator settings name. See `oauthSetupIssuerOn`.
 */
export const IssuerPort = Context.Reference<number>("e2e/IssuerPort", { defaultValue: () => 0 });

/** Start a loopback issuer with controllable discovery and registration metadata. */
export const oauthSetupIssuer = Effect.gen(function* () {
  const port = yield* IssuerPort;
  const address = yield* Deferred.make<string>();
  let registration = true;
  let postChallenge = false;
  let challenge = true;
  let probes = 0;
  let mcpStatus: 520 | undefined;
  /** Answer MCP on `/mcp` for an access token this issuer issued and still accepts. */
  let serveMcp = false;
  let expiresAt = 0;
  // 401 models RFC 7591 registration that requires an initial access token Executor lacks.
  // 429 answers with a rate limiter's HTML page.
  let registrationStatus: 200 | 201 | 400 | 401 | 429 = 201;
  /** The Retry-After header of rate-limited discovery and registration answers; unset omits it. */
  let retryAfter: string | undefined;
  /** A rate limiter's page, as an edge proxy in front of the service sends it. */
  const rateLimited = () =>
    HttpServerResponse.text(
      "<html><head><title>429 Too Many Requests</title></head><body><center><h1>429 Too Many Requests</h1></center><hr><center>synthetic-edge</center></body></html>",
      {
        status: 429,
        contentType: "text/html; charset=utf-8",
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      },
    );
  let malformedRegistration = false;
  let registrationError: "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_request" =
    "invalid_client_metadata";
  /** The `error_description` a refused registration sends; undefined omits it. */
  let registrationErrorDescription: string | undefined = "PRIVATE_PROVIDER_ERROR";
  let omitSecretExpiry = false;
  /** Vercel registers a public client whatever method the request names, as RFC 7591 allows. */
  let issuePublicClients = false;
  let nonceRequested: boolean | undefined;
  let idTokenAlgorithms: readonly string[] | undefined;
  /**
   * OpenID Connect Discovery's ID token algorithms, served beside OAuth metadata that omits them,
   * as Miro does. Its client authentication methods disagree with the OAuth metadata's.
   */
  let openidAlgorithms: readonly string[] | undefined;
  let includeIdToken = false;
  let invalidNonce = false;
  /** The ID token `iss`; Google names its sign-in host rather than the token endpoint origin. */
  let idTokenIssuer: string | undefined;
  /**
   * Google signs RS256; a declared server advertises no algorithms, so RS256 is the only default.
   * HS256 signs with the client secret, as Miro does.
   */
  let idTokenAlgorithm: "ES256" | "RS256" | "HS256" | "none" = "ES256";
  let refreshTokens = false;
  /** Replace the refresh token on every refresh, as rotating services do. */
  let rotateRefreshTokens = false;
  /** Whether a replaced refresh token is still accepted, as services with a reuse window allow. */
  let replacedRefreshTokens: "refused" | "accepted" = "refused";
  /**
   * Hold refresh requests before the service processes them, or after it has issued and saved
   * their tokens but before it answers; or hold resource reads. A held request waits for
   * `release`. One held before processing is then dropped unprocessed.
   */
  let hold: "refresh-unprocessed" | "refresh-issued" | "resource" | undefined;
  let held = 0;
  let releases: Array<Deferred.Deferred<void>> = [];
  const heldRequest = Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    releases.push(released);
    held++;
    yield* Deferred.await(released);
  });
  /** Refresh requests that issued tokens. */
  let refreshesIssued = 0;
  /** The `expires_in` of issued tokens; undefined omits it. */
  let expiresIn: number | undefined = 3600;
  /** The token request encoding the service reads; Notion and Atlassian read only JSON. */
  let tokenRequestFormat: "form" | "json" = "form";
  /** Media type of each token request, in order. */
  const tokenContentTypes: Array<string | undefined> = [];
  /** The `scope` parameter of the latest authorization request. */
  let authorizationScope: string | null | undefined;
  let tokenExchanges = 0;
  let tokenChecks: Readonly<Record<string, boolean>> = {};
  let refreshes = 0;
  let refreshChecks: Readonly<Record<string, boolean>> = {};
  /** Client authentication on the latest code exchange; background refreshes do not overwrite it. */
  let lastExchangeAuth: TokenAuth | undefined;
  /** Appended to the authorization redirect as RFC 9207 `iss`, as Google does. */
  let callbackIssuer: string | undefined;
  /** Origin of the browser page that relays a callback to the advertised redirect URI. */
  let browserReturn: string | undefined;
  // Opt-in error and token variants. Defaults keep the standard behaviour above.
  // "reset" drops the connection without a response, as a failing proxy or network would.
  // An HTML `page` is built from the request, as error pages that repeat it are. Either answer
  // can carry a Retry-After header.
  let tokenError:
    | {
        readonly status: number;
        readonly body: object;
        readonly challenge?: string;
        readonly retryAfter?: string;
      }
    | {
        readonly status: number;
        readonly page: (request: ReceivedTokenRequest) => string;
        readonly retryAfter?: string;
      }
    | "reset"
    | undefined;
  /**
   * Reshape each token response as a real service does, for example Slack's `token_type: "bot"`
   * or Mailchimp's `scope: null`. It receives the standard members and whether this is a refresh.
   */
  let tokenShape: TokenShape | undefined;
  let authorizeError: string | undefined;
  /** The ID-token subject issued on refresh. */
  let refreshSubject = "synthetic-subject";
  /** Lifetime of renewed tokens; unset, they last `expiresIn` like the first ones. */
  let refreshedExpiresIn: number | undefined;
  /** An RFC 7009 endpoint that records calls, or one that always fails. */
  let revocation: "none" | "recorded" | "failing" = "none";
  const revocations: Array<{
    readonly token: "refresh" | "access" | "unknown";
    readonly hint: string | null;
    readonly clientAuthenticated: boolean;
  }> = [];
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let rsaKey: KeyObject | undefined;
  /** Refresh tokens issued for each client; unless rotation is configured, refreshes keep them. */
  const refreshGrants = new Map<string, string>();
  /** Whether each refresh token was issued at a sign-in or by a rotating refresh. */
  const refreshOrigins = new Map<string, "sign-in" | "refresh">();
  /** The issuance of each refresh token revocation named, in order: a current or replaced one. */
  const revokedRefreshTokens: Array<"sign-in" | "refresh"> = [];
  /** Refresh tokens a rotation replaced, with their client. */
  const replacedRefreshGrants = new Map<string, string>();
  const refreshedAccessTokens = new Set<string>();
  /** Every access token issued so far. */
  const issuedAccessTokens = new Set<string>();
  /**
   * Access tokens the resource no longer accepts, as a service ends a session whose lifetime its
   * token response never stated. Salesforce answers such a token with 401 INVALID_SESSION_ID.
   */
  const expiredAccessTokens = new Set<string>();
  /** Resource requests by method, including refused ones. */
  const resourceRequests = { GET: 0, POST: 0 };
  /** The `authorization` header of each resource request, in order. */
  const resourceAuthorizations: Array<string | null> = [];
  /**
   * Which tokens the resource accepts: any, or only access tokens this issuer issued, as a real
   * service does. An unissued token is refused with 401.
   */
  let resourceTokens: "any" | "issued" = "any";
  /**
   * The `scope` member of token responses; undefined omits it. A grant is given the scope its
   * authorization request asked for, or `defaults` when it asked for none, as services that
   * grant a default set do. `exchange` and `refresh` add scopes beyond that to each response.
   * `separator` joins the reported scopes, a space by default; GitHub reports `repo,gist`.
   */
  let scopeGrant:
    | {
        readonly defaults: readonly string[];
        readonly exchange?: readonly string[];
        readonly refresh?: readonly string[];
        readonly separator?: string;
      }
    | undefined;
  /** The scope granted with each refresh token, which its renewals repeat. */
  const refreshScopes = new Map<string, string>();
  const clients = new Map<
    string,
    {
      readonly redirects: readonly string[];
      readonly secret: string | null;
      readonly methods: readonly TokenAuth[];
    }
  >();
  const codes = new Map<
    string,
    {
      clientId: string;
      redirect: string;
      challenge: string;
      nonce: string | null;
      scope: string | null;
    }
  >();
  let discovery:
    | "available"
    | "unavailable"
    | "rate-limited"
    | "missing"
    | "no-oauth"
    | "invalid-json"
    | "invalid-metadata"
    | "blocked" = "available";
  // Metadata for the path-based `/v1/mcp` endpoint, which publishes no protected-resource
  // metadata. "atlassian" misses the path-inserted URL and refuses the appended OpenID path.
  let pathDiscovery: "atlassian" | "issuer-mismatch" | "invalid-metadata" = "atlassian";
  const discoveryRequests: string[] = [];
  let scopes = ["read"];
  /** A narrower scope requirement advertised by the resource's Bearer challenge. */
  let challengeScopes: readonly string[] | undefined;
  /** Scopes the issuer grants separately but refuses together, as `invalid_scope`. */
  let exclusiveScopes: readonly string[] | undefined;
  /** An exact metadata override models OIDC published away from its declared issuer. */
  let metadataOverrideIssuer: string | undefined;
  let metadataOverrideStatus = 200;
  const scopeChallenge = () =>
    challengeScopes === undefined ? "" : `, scope="${challengeScopes.join(" ")}"`;
  let registrations = 0;
  let discoveries = 0;
  let authMethods = ["client_secret_basic"];
  /** The latest registration request, with the OpenID Connect `application_type` it named. */
  let lastRegistration:
    | { scope: string; method: string; applicationType: string | undefined }
    | undefined;
  /**
   * How the service reads HTTP Basic client credentials. "form-decoded" follows RFC 6749
   * section 2.3.1. "literal" compares them as sent, as Google and PlanetScale (Doorkeeper) do.
   */
  let basicCredentials: "form-decoded" | "literal" = "form-decoded";
  /** Credentials issued by the next registrations; unset issues numbered synthetic clients. */
  let registeredClient: { readonly clientId: string; readonly clientSecret: string } | undefined;
  /** RFC 6749 section 2.3.1 client authentication presented at the token or revocation endpoint. */
  const presentedClient = (authorization: string | undefined, input: URLSearchParams) => {
    const read = (value: string) =>
      basicCredentials === "literal" ? value : decodeURIComponent(value.replace(/\+/g, " "));
    const decoded = authorization?.startsWith("Basic ")
      ? Buffer.from(authorization.slice(6), "base64").toString("utf8")
      : "";
    const separator = decoded.indexOf(":");
    const username = separator < 0 ? undefined : read(decoded.slice(0, separator));
    const password = separator < 0 ? undefined : read(decoded.slice(separator + 1));
    const method: TokenAuth =
      authorization !== undefined
        ? "client_secret_basic"
        : input.has("client_secret")
          ? "client_secret_post"
          : "none";
    return {
      method,
      ...(method === "client_secret_basic"
        ? { clientId: username, secret: password }
        : { clientId: input.get("client_id"), secret: input.get("client_secret") }),
    };
  };
  const resource = Effect.gen(function* () {
    if (discovery === "missing" || discovery === "no-oauth")
      return HttpServerResponse.empty({ status: 404 });
    const origin = yield* Deferred.await(address);
    return yield* HttpServerResponse.json({
      resource: `${origin}/mcp`,
      authorization_servers: [discovery === "blocked" ? "http://blocked.internal:8081" : origin],
      scopes_supported: scopes,
    });
  });
  /** Whether a request presents an access token this issuer issued and has not ended. */
  const acceptedToken = (authorization: string | undefined) => {
    const token = authorization?.replace(/^Bearer /, "");
    return token !== undefined && issuedAccessTokens.has(token) && !expiredAccessTokens.has(token);
  };
  /**
   * An OAuth-protected MCP server's answer to an accepted token: initialization, notifications and
   * an empty tool list over plain JSON responses, with no session.
   */
  const mcpAnswer = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const message = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(McpMessage)),
    );
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    return yield* HttpServerResponse.json({
      jsonrpc: "2.0",
      id: message.id,
      ...(message.method === "initialize"
        ? {
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-oauth-mcp", version: "1" },
            },
          }
        : message.method === "tools/list"
          ? { result: { tools: [] } }
          : { error: { code: -32601, message: "Method not found" } }),
    });
  }).pipe(Effect.orDie);
  /** OpenID Connect Discovery for `issuer`, whose client authentication differs from OAuth's. */
  const openidDocument = (issuer: string, algorithms: readonly string[]) =>
    Effect.gen(function* () {
      const origin = yield* Deferred.await(address);
      return yield* HttpServerResponse.json({
        issuer,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: algorithms,
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/jwks",
      HttpServerResponse.json({
        keys: [
          {
            ...keyPair.publicKey.export({ format: "jwk" }),
            alg: "ES256",
            use: "sig",
            kid: "synthetic-key",
          },
        ],
      }),
    ),
    HttpRouter.add(
      "GET",
      "/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URL(request.url, "http://localhost").searchParams;
        const clientId = params.get("client_id"),
          redirect = params.get("redirect_uri"),
          challenge = params.get("code_challenge");
        if (
          clientId === null ||
          redirect === null ||
          challenge === null ||
          params.get("code_challenge_method") !== "S256" ||
          !clients.get(clientId)?.redirects.includes(redirect)
        )
          return HttpServerResponse.empty({ status: 400 });
        const code = randomUUID();
        nonceRequested = params.get("nonce") !== null;
        authorizationScope = params.get("scope");
        const requested = authorizationScope?.split(" ") ?? [];
        const refusal =
          authorizeError ??
          (requested.filter((scope) => exclusiveScopes?.includes(scope)).length > 1
            ? "invalid_scope"
            : undefined);
        const callback = new URL(redirect);
        if (refusal === undefined) {
          codes.set(code, {
            clientId,
            redirect,
            challenge,
            nonce: params.get("nonce"),
            scope: params.get("scope"),
          });
          callback.searchParams.set("code", code);
        } else callback.searchParams.set("error", refusal);
        callback.searchParams.set("state", params.get("state") ?? "");
        if (callbackIssuer !== undefined) callback.searchParams.set("iss", callbackIssuer);
        // The managed host advertises a separate callback relay; model its browser return.
        const location =
          browserReturn === undefined
            ? callback
            : Object.assign(new URL("/oauth/callback", browserReturn), { search: callback.search });
        return HttpServerResponse.empty({ status: 302, headers: { location: location.href } });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
        const text = yield* request.text;
        const input = tokenRequestParameters(contentType, text);
        const refreshing = input.get("grant_type") === "refresh_token";
        if (refreshing && hold === "refresh-unprocessed") {
          // The service never processes this request; its caller is gone once it is released.
          yield* heldRequest;
          return HttpServerResponse.empty({ status: 503 });
        }
        if (refreshing) refreshes++;
        else tokenExchanges++;
        tokenContentTypes.push(contentType);
        if (tokenError === "reset") {
          const source = request.source;
          if (!("socket" in source) || !(source.socket instanceof Socket))
            return yield* Effect.die("OAuth fixture needs the Node request socket");
          source.socket.destroy();
          return HttpServerResponse.empty({ status: 500 });
        }
        const errorHeaders =
          tokenError === undefined || tokenError.retryAfter === undefined
            ? {}
            : { "retry-after": tokenError.retryAfter };
        if (tokenError !== undefined && "page" in tokenError)
          return HttpServerResponse.text(
            tokenError.page({ body: text, authorization: request.headers.authorization }),
            {
              status: tokenError.status,
              contentType: "text/html; charset=utf-8",
              headers: errorHeaders,
            },
          );
        if (tokenError !== undefined)
          return yield* HttpServerResponse.json(tokenError.body, {
            status: tokenError.status,
            headers:
              tokenError.challenge === undefined
                ? errorHeaders
                : { ...errorHeaders, "www-authenticate": tokenError.challenge },
          });
        const code = input.get("code"),
          verifier = input.get("code_verifier"),
          presentedRefresh = input.get("refresh_token");
        const issued = refreshing || code === null ? undefined : codes.get(code);
        const refreshClient =
          refreshing && presentedRefresh !== null
            ? (refreshGrants.get(presentedRefresh) ??
              (replacedRefreshTokens === "accepted"
                ? replacedRefreshGrants.get(presentedRefresh)
                : undefined))
            : undefined;
        const clientId = refreshing ? refreshClient : issued?.clientId;
        const authorization = request.headers.authorization;
        const presented = presentedClient(authorization, input);
        const method = presented.method;
        if (!refreshing) lastExchangeAuth = method;
        const client = clientId === undefined ? undefined : clients.get(clientId);
        const authChecks = {
          format:
            contentType ===
            (tokenRequestFormat === "json"
              ? "application/json"
              : "application/x-www-form-urlencoded"),
          authScheme:
            method !== "client_secret_basic" || authorization?.startsWith("Basic ") === true,
          authMethod: client?.methods.includes(method) === true,
          authClient: clientId !== undefined && presented.clientId === clientId,
          authSecret:
            client !== undefined &&
            (client.secret === null ? method === "none" : presented.secret === client.secret),
        };
        if (refreshing) refreshChecks = { issued: refreshClient !== undefined, ...authChecks };
        else
          tokenChecks = {
            issued: issued !== undefined,
            grant: input.get("grant_type") === "authorization_code",
            redirect: issued !== undefined && input.get("redirect_uri") === issued.redirect,
            pkce:
              issued !== undefined &&
              verifier !== null &&
              createHash("sha256").update(verifier).digest("base64url") === issued.challenge,
            ...authChecks,
          };
        if (
          clientId === undefined ||
          client === undefined ||
          !Object.values(refreshing ? refreshChecks : tokenChecks).every(Boolean)
        )
          return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
        if (code !== null) codes.delete(code);
        const origin = yield* Deferred.await(address);
        const now = Math.floor(Date.now() / 1000);
        // A refreshed ID token carries no nonce (OpenID Connect Core 12.2). `invalidNonce`
        // names one the client never sent, on every ID token.
        const nonce = invalidNonce ? "wrong-nonce" : (issued?.nonce ?? null);
        const jwt = [
          { alg: idTokenAlgorithm, kid: "synthetic-key", typ: "JWT" },
          {
            iss: idTokenIssuer ?? origin,
            aud: clientId,
            sub: refreshing ? refreshSubject : "synthetic-subject",
            iat: now,
            exp: now + 3600,
            ...(nonce === null ? {} : { nonce }),
          },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
          .join(".");
        const signature =
          idTokenAlgorithm === "none"
            ? ""
            : idTokenAlgorithm === "HS256"
              ? // A public client shares no secret to sign with.
                client.secret === null
                ? ""
                : createHmac("sha256", client.secret).update(jwt).digest("base64url")
              : idTokenAlgorithm === "ES256"
                ? sign("sha256", Buffer.from(jwt), {
                    key: keyPair.privateKey,
                    dsaEncoding: "ieee-p1363",
                  }).toString("base64url")
                : sign(
                    "sha256",
                    Buffer.from(jwt),
                    (rsaKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey),
                  ).toString("base64url");
        const accessToken = refreshing
          ? `synthetic-refreshed-token-${refreshes}`
          : "synthetic-access-token";
        if (refreshing) refreshedAccessTokens.add(accessToken);
        issuedAccessTokens.add(accessToken);
        // Every sign-in issues the same first token; a new sign-in makes it valid again.
        expiredAccessTokens.delete(accessToken);
        const refreshToken =
          refreshTokens && (!refreshing || rotateRefreshTokens)
            ? `synthetic-refresh-${randomUUID()}`
            : undefined;
        if (refreshToken !== undefined) {
          refreshGrants.set(refreshToken, clientId);
          refreshOrigins.set(refreshToken, refreshing ? "refresh" : "sign-in");
        }
        if (refreshing && rotateRefreshTokens && presentedRefresh !== null) {
          // The presented token is consumed by this rotation, whether or not its answer arrives.
          if (refreshGrants.delete(presentedRefresh))
            replacedRefreshGrants.set(presentedRefresh, clientId);
        }
        if (refreshing) refreshesIssued++;
        const lifetime = refreshing ? (refreshedExpiresIn ?? expiresIn) : expiresIn;
        // The grant's scope: as authorized, or the defaults when the request named none, then
        // anything this response adds beyond it.
        const granted =
          scopeGrant === undefined
            ? undefined
            : ((refreshing && presentedRefresh !== null
                ? refreshScopes.get(presentedRefresh)
                : issued?.scope) ?? scopeGrant.defaults.join(" "));
        const scope =
          scopeGrant === undefined || granted === undefined
            ? undefined
            : [
                ...new Set([
                  ...granted.split(" ").filter(Boolean),
                  ...((refreshing ? scopeGrant.refresh : scopeGrant.exchange) ?? []),
                ]),
              ].join(scopeGrant.separator ?? " ");
        if (refreshToken !== undefined && granted !== undefined)
          refreshScopes.set(refreshToken, granted);
        if (refreshing && hold === "refresh-issued") yield* heldRequest;
        const tokens: IssuedTokens = {
          access_token: accessToken,
          token_type: "Bearer",
          ...(lifetime === undefined ? {} : { expires_in: lifetime }),
          ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
          ...(includeIdToken ? { id_token: `${jwt}.${signature}` } : {}),
          ...(scope === undefined ? {} : { scope }),
        };
        return yield* HttpServerResponse.json(
          tokenShape === undefined ? tokens : tokenShape(tokens, refreshing),
        );
      }),
    ),
    ...(["GET", "POST"] as const).map((method) =>
      HttpRouter.add(
        method,
        "/resource",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization ?? null;
          const token = authorization?.replace(/^Bearer /, "") ?? "";
          resourceRequests[method]++;
          resourceAuthorizations.push(authorization);
          if (hold === "resource") yield* heldRequest;
          // RFC 6750 §3.1: the request was not performed because its token is no longer valid.
          if (
            expiredAccessTokens.has(token) ||
            (resourceTokens === "issued" && !issuedAccessTokens.has(token))
          )
            return yield* HttpServerResponse.json(
              [{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }],
              {
                status: 401,
                headers: { "www-authenticate": 'Bearer error="invalid_token"' },
              },
            );
          // Report whether a renewed token was presented, and echo the credential itself.
          return yield* HttpServerResponse.json({
            refreshed: refreshedAccessTokens.has(token),
            authorization,
          });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/mcp",
      Effect.gen(function* () {
        probes++;
        if (mcpStatus !== undefined) return HttpServerResponse.empty({ status: mcpStatus });
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The served MCP server offers no standalone SSE stream.
        if (postChallenge || (serveMcp && acceptedToken(request.headers.authorization)))
          return HttpServerResponse.empty({ status: 405 });
        if (discovery === "no-oauth") return HttpServerResponse.empty({ status: 200 });
        const origin = yield* Deferred.await(address);
        return HttpServerResponse.empty({
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${scopeChallenge()}`,
          },
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        probes++;
        if (mcpStatus !== undefined) return HttpServerResponse.empty({ status: mcpStatus });
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (serveMcp && acceptedToken(request.headers.authorization)) return yield* mcpAnswer;
        const origin = yield* Deferred.await(address);
        return HttpServerResponse.empty({
          status: 401,
          headers: challenge
            ? {
                "www-authenticate": `Bearer resource_metadata="${origin}/challenge-resource"${scopeChallenge()}`,
              }
            : {},
        });
      }),
    ),
    HttpRouter.add("GET", "/challenge-resource", resource),
    // Like Atlassian's MCP endpoint, `/v1/mcp` challenges without naming resource metadata.
    HttpRouter.add(
      "*",
      "/v1/mcp",
      Effect.sync(() =>
        HttpServerResponse.empty({
          status: 401,
          headers: {
            "www-authenticate":
              challengeScopes === undefined
                ? "Bearer"
                : `Bearer scope="${challengeScopes.join(" ")}"`,
          },
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server/v1/mcp",
      Effect.gen(function* () {
        discoveryRequests.push("/.well-known/oauth-authorization-server/v1/mcp");
        if (pathDiscovery === "atlassian") return HttpServerResponse.empty({ status: 404 });
        const origin = yield* Deferred.await(address);
        if (pathDiscovery === "invalid-metadata")
          return yield* HttpServerResponse.json({ issuer: `${origin}/v1/mcp` });
        return yield* HttpServerResponse.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: authMethods,
          scopes_supported: scopes,
          registration_endpoint: `${origin}/register`,
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/v1/mcp/.well-known/openid-configuration",
      Effect.sync(() => {
        discoveryRequests.push("/v1/mcp/.well-known/openid-configuration");
        return HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": "Bearer" } });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      Effect.suspend(() =>
        postChallenge ? Effect.succeed(HttpServerResponse.empty({ status: 404 })) : resource,
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/openid-configuration",
      Effect.gen(function* () {
        discoveryRequests.push("/.well-known/openid-configuration");
        if (openidAlgorithms === undefined) return HttpServerResponse.empty({ status: 404 });
        return yield* openidDocument(yield* Deferred.await(address), openidAlgorithms);
      }),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        discoveries++;
        discoveryRequests.push("/.well-known/oauth-authorization-server");
        if (discovery === "unavailable") return HttpServerResponse.empty({ status: 503 });
        if (discovery === "rate-limited") return rateLimited();
        if (discovery === "missing" || discovery === "no-oauth")
          return HttpServerResponse.empty({ status: 404 });
        if (discovery === "invalid-json")
          return HttpServerResponse.text("PRIVATE_UPSTREAM_DIAGNOSTIC", {
            contentType: "application/json",
          });
        const origin = yield* Deferred.await(address);
        return yield* HttpServerResponse.json({
          issuer: discovery === "invalid-metadata" ? `${origin}/wrong-issuer` : origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: authMethods,
          ...(idTokenAlgorithms === undefined
            ? {}
            : { id_token_signing_alg_values_supported: idTokenAlgorithms }),
          jwks_uri: `${origin}/jwks`,
          scopes_supported: scopes,
          ...(registration
            ? { registration_endpoint: `${origin}/register?fixture=PRIVATE_QUERY` }
            : {}),
          ...(revocation === "none" ? {} : { revocation_endpoint: `${origin}/revoke` }),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/oauth/.well-known/openid-configuration",
      Effect.gen(function* () {
        discoveryRequests.push("/oauth/.well-known/openid-configuration");
        if (metadataOverrideStatus !== 200)
          return HttpServerResponse.empty({ status: metadataOverrideStatus });
        const origin = yield* Deferred.await(address);
        return yield* HttpServerResponse.json({
          issuer: metadataOverrideIssuer ?? origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: authMethods,
          id_token_signing_alg_values_supported: ["ES256"],
          jwks_uri: `${origin}/jwks`,
          scopes_supported: scopes,
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/revoke",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = new URLSearchParams(yield* request.text);
        const presented = presentedClient(request.headers.authorization, input);
        const client =
          typeof presented.clientId === "string" ? clients.get(presented.clientId) : undefined;
        const token = input.get("token");
        const origin = token === null ? undefined : refreshOrigins.get(token);
        if (origin !== undefined) revokedRefreshTokens.push(origin);
        revocations.push({
          token:
            token !== null && refreshGrants.has(token)
              ? "refresh"
              : token === "synthetic-access-token" ||
                  (token !== null && refreshedAccessTokens.has(token))
                ? "access"
                : "unknown",
          hint: input.get("token_type_hint"),
          clientAuthenticated:
            client !== undefined &&
            client.methods.includes(presented.method) &&
            client.secret !== null &&
            presented.secret === client.secret,
        });
        return revocation === "failing"
          ? HttpServerResponse.empty({ status: 503 })
          : HttpServerResponse.empty({ status: 200 });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/register",
      Effect.gen(function* () {
        registrations++;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                redirect_uris: Schema.Array(Schema.String),
                token_endpoint_auth_method: Schema.String,
                scope: Schema.optional(Schema.String),
                application_type: Schema.optional(Schema.String),
              }),
            ),
          ),
        );
        lastRegistration = {
          scope: input.scope ?? "",
          method: input.token_endpoint_auth_method,
          applicationType: input.application_type,
        };
        const description =
          registrationErrorDescription === undefined
            ? {}
            : { error_description: registrationErrorDescription };
        if (registrationStatus === 429) return rateLimited();
        if (registrationStatus === 401)
          return yield* HttpServerResponse.json(
            { error: "invalid_client", ...description },
            { status: 401 },
          );
        if (registrationStatus === 400)
          return yield* HttpServerResponse.json(
            { error: registrationError, ...description },
            { status: 400 },
          );
        const issued = registeredClient ?? {
          clientId: `synthetic-client-${registrations}`,
          clientSecret: "synthetic-client-secret",
        };
        // The client authenticates with the method it registered, as RFC 7591 section 2 defines.
        if (!malformedRegistration)
          clients.set(issued.clientId, {
            redirects: input.redirect_uris,
            secret: issuePublicClients ? null : issued.clientSecret,
            methods: issuePublicClients
              ? ["none"]
              : [
                  input.token_endpoint_auth_method === "client_secret_post"
                    ? "client_secret_post"
                    : "client_secret_basic",
                ],
          });
        return yield* HttpServerResponse.json(
          {
            ...(malformedRegistration ? {} : { client_id: issued.clientId }),
            ...(issuePublicClients
              ? { token_endpoint_auth_method: "none" }
              : {
                  client_secret: issued.clientSecret,
                  ...(omitSecretExpiry ? {} : { client_secret_expires_at: expiresAt }),
                  token_endpoint_auth_method: input.token_endpoint_auth_method,
                }),
            redirect_uris: input.redirect_uris,
          },
          { status: registrationStatus },
        );
      }),
    ),
  );
  const listener = yield* Effect.sync(() => createServer());
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port })),
    ),
  );
  // Scenario work has ended. Release unfinished provider requests before the
  // HTTP adapter waits for its listener to close.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(releases, (released) => Deferred.succeed(released, undefined), {
      discard: true,
    }).pipe(Effect.andThen(Effect.sync(() => listener.closeAllConnections()))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("OAuth fixture needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, origin);
  return {
    origin,
    configure: (input: {
      readonly registration?: boolean;
      readonly registrationStatus?: typeof registrationStatus;
      readonly malformedRegistration?: boolean;
      readonly registrationError?: typeof registrationError;
      /** The `error_description` of a refused registration; null omits it. */
      readonly registrationErrorDescription?: string | null;
      /** The Retry-After header of rate-limited discovery and registration; null omits it. */
      readonly retryAfter?: string | null;
      readonly omitSecretExpiry?: boolean;
      /** Register every client as public, replacing the requested token endpoint method. */
      readonly issuePublicClients?: boolean;
      /** Advertised ID token algorithms; null omits them from OAuth metadata. */
      readonly idTokenAlgorithms?: readonly string[] | null;
      /** Serve OpenID Connect Discovery with these ID token algorithms; null serves none. */
      readonly openidAlgorithms?: readonly string[] | null;
      readonly includeIdToken?: boolean;
      readonly idTokenIssuer?: string | null;
      readonly idTokenAlgorithm?: typeof idTokenAlgorithm;
      readonly refreshTokens?: boolean;
      /** Replace the refresh token on every refresh. */
      readonly rotateRefreshTokens?: boolean;
      /** Whether a replaced refresh token is still accepted. */
      readonly replacedRefreshTokens?: typeof replacedRefreshTokens;
      /** Hold matching requests until `release`; null stops holding new ones. */
      readonly hold?: typeof hold | null;
      /** The `expires_in` of issued tokens; null omits it. */
      readonly expiresIn?: number | null;
      readonly invalidNonce?: boolean;
      readonly postChallenge?: boolean;
      readonly challenge?: boolean;
      readonly mcpStatus?: 520 | null;
      /**
       * Answer MCP on `/mcp` for an access token this issuer issued and has not ended, as an
       * OAuth-protected MCP server does. Requests without one keep the challenge.
       */
      readonly serveMcp?: boolean;
      readonly expiresAt?: number;
      readonly discovery?: typeof discovery;
      readonly pathDiscovery?: typeof pathDiscovery;
      readonly scopes?: readonly string[];
      readonly challengeScopes?: readonly string[] | null;
      /** Refuse an authorization request naming more than one of these; null accepts any. */
      readonly exclusiveScopes?: readonly string[] | null;
      readonly metadataOverrideIssuer?: string | null;
      readonly metadataOverrideStatus?: number;
      readonly authMethods?: readonly string[];
      readonly callbackIssuer?: string | null;
      readonly browserReturn?: string | null;
      /**
       * Answer every token request with this JSON body, status and optional challenge, or an HTML
       * page built from the request, either with an optional Retry-After, or drop the connection
       * with "reset"; null restores tokens.
       */
      readonly tokenError?: typeof tokenError | null;
      /** Reshape token responses like a real service; null restores the standard shape. */
      readonly tokenShape?: TokenShape | null;
      /** Return this RFC 6749 error code to the callback instead of a code; null restores codes. */
      readonly authorizeError?: string | null;
      /** The ID-token subject issued on refresh. */
      readonly refreshSubject?: string;
      /** Lifetime of renewed tokens; null makes them last `expiresIn`. */
      readonly refreshedExpiresIn?: number | null;
      /** Advertise an RFC 7009 endpoint that records calls, or one that always fails. */
      readonly revocation?: typeof revocation;
      /** How the token and revocation endpoints read HTTP Basic client credentials. */
      readonly basicCredentials?: typeof basicCredentials;
      /** Credentials issued by the next registrations; null restores numbered synthetic clients. */
      readonly registeredClient?: typeof registeredClient | null;
      /** The token request encoding the service accepts; it refuses the other one. */
      readonly tokenRequestFormat?: typeof tokenRequestFormat;
      /** Grant scopes in token responses; null omits `scope`. See `scopeGrant`. */
      readonly scopeGrant?: typeof scopeGrant | null;
      /** Which access tokens the resource accepts. */
      readonly resourceTokens?: typeof resourceTokens;
    }) =>
      Effect.sync(() => {
        if (input.scopeGrant !== undefined)
          scopeGrant = input.scopeGrant === null ? undefined : input.scopeGrant;
        if (input.resourceTokens !== undefined) resourceTokens = input.resourceTokens;
        if (input.tokenRequestFormat !== undefined) tokenRequestFormat = input.tokenRequestFormat;
        if (input.mcpStatus !== undefined)
          mcpStatus = input.mcpStatus === null ? undefined : input.mcpStatus;
        if (input.serveMcp !== undefined) serveMcp = input.serveMcp;
        if (input.postChallenge !== undefined) postChallenge = input.postChallenge;
        if (input.challenge !== undefined) challenge = input.challenge;
        if (input.idTokenAlgorithms !== undefined)
          idTokenAlgorithms =
            input.idTokenAlgorithms === null ? undefined : input.idTokenAlgorithms;
        if (input.openidAlgorithms !== undefined)
          openidAlgorithms = input.openidAlgorithms === null ? undefined : input.openidAlgorithms;
        if (input.includeIdToken !== undefined) includeIdToken = input.includeIdToken;
        if (input.idTokenIssuer !== undefined)
          idTokenIssuer = input.idTokenIssuer === null ? undefined : input.idTokenIssuer;
        if (input.idTokenAlgorithm !== undefined) idTokenAlgorithm = input.idTokenAlgorithm;
        if (input.refreshTokens !== undefined) refreshTokens = input.refreshTokens;
        if (input.rotateRefreshTokens !== undefined)
          rotateRefreshTokens = input.rotateRefreshTokens;
        if (input.replacedRefreshTokens !== undefined)
          replacedRefreshTokens = input.replacedRefreshTokens;
        if (input.hold !== undefined) hold = input.hold === null ? undefined : input.hold;
        if (input.expiresIn !== undefined)
          expiresIn = input.expiresIn === null ? undefined : input.expiresIn;
        if (input.invalidNonce !== undefined) invalidNonce = input.invalidNonce;
        if (input.registrationStatus !== undefined) registrationStatus = input.registrationStatus;
        if (input.malformedRegistration !== undefined)
          malformedRegistration = input.malformedRegistration;
        if (input.registrationError !== undefined) registrationError = input.registrationError;
        if (input.registrationErrorDescription !== undefined)
          registrationErrorDescription =
            input.registrationErrorDescription === null
              ? undefined
              : input.registrationErrorDescription;
        if (input.retryAfter !== undefined)
          retryAfter = input.retryAfter === null ? undefined : input.retryAfter;
        if (input.omitSecretExpiry !== undefined) omitSecretExpiry = input.omitSecretExpiry;
        if (input.issuePublicClients !== undefined) issuePublicClients = input.issuePublicClients;
        if (input.registration !== undefined) registration = input.registration;
        if (input.expiresAt !== undefined) expiresAt = input.expiresAt;
        if (input.discovery !== undefined) discovery = input.discovery;
        if (input.pathDiscovery !== undefined) pathDiscovery = input.pathDiscovery;
        if (input.scopes !== undefined) scopes = [...input.scopes];
        if (input.challengeScopes !== undefined)
          challengeScopes = input.challengeScopes === null ? undefined : input.challengeScopes;
        if (input.exclusiveScopes !== undefined)
          exclusiveScopes = input.exclusiveScopes === null ? undefined : input.exclusiveScopes;
        if (input.metadataOverrideIssuer !== undefined)
          metadataOverrideIssuer =
            input.metadataOverrideIssuer === null ? undefined : input.metadataOverrideIssuer;
        if (input.metadataOverrideStatus !== undefined)
          metadataOverrideStatus = input.metadataOverrideStatus;
        if (input.authMethods !== undefined) authMethods = [...input.authMethods];
        if (input.callbackIssuer !== undefined)
          callbackIssuer = input.callbackIssuer === null ? undefined : input.callbackIssuer;
        if (input.browserReturn !== undefined)
          browserReturn = input.browserReturn === null ? undefined : input.browserReturn;
        if (input.tokenError !== undefined)
          tokenError = input.tokenError === null ? undefined : input.tokenError;
        if (input.tokenShape !== undefined)
          tokenShape = input.tokenShape === null ? undefined : input.tokenShape;
        if (input.authorizeError !== undefined)
          authorizeError = input.authorizeError === null ? undefined : input.authorizeError;
        if (input.refreshSubject !== undefined) refreshSubject = input.refreshSubject;
        if (input.refreshedExpiresIn !== undefined)
          refreshedExpiresIn =
            input.refreshedExpiresIn === null ? undefined : input.refreshedExpiresIn;
        if (input.revocation !== undefined) revocation = input.revocation;
        if (input.basicCredentials !== undefined) basicCredentials = input.basicCredentials;
        if (input.registeredClient !== undefined)
          registeredClient = input.registeredClient === null ? undefined : input.registeredClient;
      }),
    /**
     * Accept a client configured by hand at the service; one without a secret is a public PKCE
     * client. One with a secret authenticates with the listed methods. RFC 6749 section 2.3.1
     * requires HTTP Basic and makes the request body optional, so Basic alone is the default;
     * HubSpot, Twitch and Mailchimp read only the body.
     */
    allowClient: (input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly redirect: string;
      readonly methods?: readonly SecretAuth[];
    }) =>
      Effect.sync(() => {
        clients.set(input.clientId, {
          redirects: [input.redirect],
          secret: input.clientSecret ?? null,
          methods:
            input.clientSecret === undefined
              ? ["none"]
              : [...(input.methods ?? ["client_secret_basic"])],
        });
      }),
    /** End every access token issued so far; the resource refuses them with 401 from now on. */
    expireAccessTokens: Effect.sync(() => {
      for (const token of issuedAccessTokens) expiredAccessTokens.add(token);
    }),
    /** Answer every held request; one held before processing stays unprocessed. */
    release: Effect.suspend(() => {
      const pending = releases;
      releases = [];
      return Effect.forEach(pending, (released) => Deferred.succeed(released, undefined), {
        discard: true,
      });
    }),
    metrics: Effect.sync(() => ({
      held,
      refreshesIssued,
      registrations,
      discoveries,
      discoveryRequests: [...discoveryRequests],
      lastRegistration,
      probes,
      tokenExchanges,
      tokenChecks,
      tokenContentTypes: [...tokenContentTypes],
      authorizationScope,
      refreshes,
      refreshChecks,
      lastExchangeAuth,
      nonceRequested,
      revocations: [...revocations],
      revokedRefreshTokens: [...revokedRefreshTokens],
      resourceRequests: { ...resourceRequests },
      resourceAuthorizations: [...resourceAuthorizations],
    })),
  };
});

/** Start an issuer on `port`, such as one an operator's settings already name. */
export const oauthSetupIssuerOn = (port: number) =>
  oauthSetupIssuer.pipe(Effect.provideService(IssuerPort, port));
