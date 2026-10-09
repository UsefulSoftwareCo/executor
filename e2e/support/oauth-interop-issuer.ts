/**
 * Loopback MCP servers whose authorization servers reproduce specific services' OAuth behaviour.
 * Executor still uses its real discovery, registration, callback and token paths against them.
 */
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { tokenRequestParameters } from "./client-credentials-issuer.ts";

/**
 * - `entra-tenant`: Microsoft identity platform v2.0 for one tenant. It publishes only OpenID
 *   configuration, has no registration endpoint, and rejects an RFC 8707 `resource` with
 *   `invalid_target` (AADSTS9010010) because the audience comes from the scopes.
 * - `entra-common`: the multi-tenant `common` endpoint. Its metadata names a `{tenantid}` issuer
 *   template, and ID tokens carry the signed-in user's tenant issuer and `tid`.
 * - `apple`: the RFC 8414 location redirects (302); OpenID configuration is at the origin.
 * - `atlassian`: the path-inserted RFC 8414 location refuses with 401; the issuer's appended
 *   OpenID configuration serves its metadata.
 * - `openid-inserted`: an issuer with a path publishes only OpenID configuration with that path
 *   inserted after the well-known segment (RFC 8414 §5).
 * - `singular`: advertises only the authorization_code grant and rejects a registration that
 *   asks for refresh_token with `invalid_client_metadata`.
 * - `cloudflare-access`: rejects a registration whose redirect URI is not on its allowlist with
 *   `invalid_client_metadata`.
 * - `facebook`: appends `#_=_` to the callback redirect.
 * - `ahrefs`: answers the MCP endpoint's GET with 400 and no challenge. Its resource and issuer
 *   are the origin with a trailing slash, its resource metadata lists `scopes_provided` instead
 *   of `scopes_supported`, and its server metadata names no client authentication methods and
 *   no refresh grant. The token endpoint compares the whole Content-Type header and refuses any
 *   other label, including a `charset` parameter, with a non-OAuth error body.
 *
 * Both Entra services issue refresh tokens, and a refreshed ID token names a tenant again.
 * Like Microsoft's and Apple's published metadata, the Entra and Apple fixtures list no
 * `code_challenge_methods_supported`; every service requires an S256 challenge at `/authorize`.
 */
export type InteropService =
  | "entra-tenant"
  | "entra-common"
  | "apple"
  | "atlassian"
  | "openid-inserted"
  | "singular"
  | "cloudflare-access"
  | "facebook"
  | "ahrefs";

/** The signed-in user's Microsoft tenant, and a different one for mismatched tokens. */
export const entraTenant = "8a0f2c35-6b1d-4c9e-9f4a-1d2b3c4d5e6f" as const;
export const otherTenant = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9" as const;
/** A client registered by hand, as Microsoft Entra requires. */
export const entraClient = { clientId: "synthetic-entra-client", clientSecret: "synthetic-secret" };
/** An Entra-style scope whose prefix names the API the token is for. */
export const entraApiScope = "api://synthetic-mcp/access";

const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.String,
  grant_types: Schema.optional(Schema.Array(Schema.String)),
});

export const oauthInteropIssuer = (service: InteropService) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    const entra = service === "entra-tenant" || service === "entra-common";
    const ahrefs = service === "ahrefs";
    const issuerPath =
      service === "entra-tenant"
        ? `/${entraTenant}/v2.0`
        : service === "entra-common"
          ? "/common/v2.0"
          : service === "atlassian" || service === "openid-inserted"
            ? "/oauth"
            : ahrefs
              ? "/"
              : "";
    /** ID tokens name this tenant in `iss` but claim `entraTenant` in `tid`. */
    let mismatchedTenantIssuer = false;
    /** The tenant a refreshed ID token names in both `tid` and `iss`, with the same `sub`. */
    let refreshTenant: string = entraTenant;
    /** Lifetime of tokens from the code exchange; a short one makes the first use renew. */
    let exchangedExpiresIn = 3600;
    /** Refresh tokens issued, by the client they belong to. */
    const refreshGrants = new Map<string, string>();
    const refreshedAccessTokens = new Set<string>();
    const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const clients = new Map<string, { secret: string; grantTypes: readonly string[] }>(
      entra
        ? [
            [
              entraClient.clientId,
              {
                secret: entraClient.clientSecret,
                grantTypes: ["authorization_code", "refresh_token"],
              },
            ],
          ]
        : [],
    );
    const codes = new Map<
      string,
      { clientId: string; redirect: string; challenge: string; nonce: string | null; scope: string }
    >();
    const discoveryRequests: string[] = [];
    const authorizations: Array<{ readonly resource: string | null }> = [];
    const registrations: Array<{
      readonly grantTypes: readonly string[] | undefined;
      readonly accepted: boolean;
    }> = [];
    const tokenRequests: Array<{ readonly resource: string | null; readonly issued: boolean }> = [];
    /** The Content-Type header of each token request, as sent. */
    const tokenContentTypes: Array<string | undefined> = [];
    const refreshes: Array<{ readonly tenant: string; readonly issued: boolean }> = [];

    const metadata = Effect.gen(function* () {
      const origin = yield* Deferred.await(address);
      if (ahrefs)
        return yield* HttpServerResponse.json({
          issuer: `${origin}${issuerPath}`,
          registration_endpoint: `${origin}/register`,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          scopes_supported: ["read"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["implicit", "authorization_code", "authorization_code_with_pkce"],
        });
      return yield* HttpServerResponse.json({
        issuer: service === "entra-common" ? `${origin}/{tenantid}/v2.0` : `${origin}${issuerPath}`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ["code"],
        ...(entra || service === "apple" ? {} : { code_challenge_methods_supported: ["S256"] }),
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: entra ? ["openid", "profile", "email", "offline_access"] : ["read"],
        ...(entra
          ? // Microsoft identity platform's own metadata extension, published in every cloud.
            { cloud_instance_name: "microsoftonline.com" }
          : {
              registration_endpoint: `${origin}/register`,
              grant_types_supported:
                service === "singular"
                  ? ["authorization_code"]
                  : ["authorization_code", "refresh_token"],
            }),
      });
    });
    /** Every metadata location the services use; each service answers only its own. */
    const locations = {
      rfc8414: "/.well-known/oauth-authorization-server",
      openId: "/.well-known/openid-configuration",
      insertedRfc8414: "/.well-known/oauth-authorization-server/oauth",
      insertedOpenId: "/.well-known/openid-configuration/oauth",
      appendedOpenId: "/oauth/.well-known/openid-configuration",
      entraCommon: "/common/v2.0/.well-known/openid-configuration",
      entraTenant: `/${entraTenant}/v2.0/.well-known/openid-configuration`,
    } as const;
    const answers: Partial<Record<keyof typeof locations, "metadata" | "redirect" | "refused">> =
      service === "apple"
        ? { rfc8414: "redirect", openId: "metadata" }
        : service === "atlassian"
          ? { insertedRfc8414: "refused", appendedOpenId: "metadata" }
          : service === "openid-inserted"
            ? { insertedOpenId: "metadata" }
            : service === "entra-common"
              ? { entraCommon: "metadata" }
              : service === "entra-tenant"
                ? { entraTenant: "metadata" }
                : { rfc8414: "metadata" };
    const wellKnown = (location: keyof typeof locations) =>
      HttpRouter.add(
        "GET",
        locations[location],
        Effect.suspend(() => {
          discoveryRequests.push(locations[location]);
          const answer = answers[location];
          return answer === "metadata"
            ? metadata
            : Effect.succeed(
                answer === "redirect"
                  ? HttpServerResponse.empty({
                      status: 302,
                      headers: { location: "https://www.example.com/" },
                    })
                  : answer === "refused"
                    ? HttpServerResponse.empty({
                        status: 401,
                        headers: { "www-authenticate": "Bearer" },
                      })
                    : HttpServerResponse.empty({ status: 404 }),
              );
        }),
      );

    const challenge = Effect.gen(function* () {
      const origin = yield* Deferred.await(address);
      return HttpServerResponse.empty({
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    });

    const routes = Layer.mergeAll(
      wellKnown("rfc8414"),
      wellKnown("openId"),
      wellKnown("insertedRfc8414"),
      wellKnown("insertedOpenId"),
      wellKnown("appendedOpenId"),
      wellKnown("entraCommon"),
      wellKnown("entraTenant"),
      HttpRouter.add(
        "GET",
        "/mcp",
        ahrefs ? Effect.succeed(HttpServerResponse.empty({ status: 400 })) : challenge,
      ),
      HttpRouter.add("POST", "/mcp", challenge),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/mcp",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json(
            ahrefs
              ? {
                  resource: `${origin}/`,
                  authorization_servers: [`${origin}${issuerPath}`],
                  scopes_provided: ["read"],
                }
              : {
                  resource: `${origin}/mcp`,
                  authorization_servers: [`${origin}${issuerPath}`],
                  scopes_supported: entra ? ["openid", entraApiScope] : ["read"],
                },
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/register",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
          );
          const grantTypes = input.grant_types ?? ["authorization_code"];
          const refused =
            (service === "singular" &&
              grantTypes.some((grant) => grant !== "authorization_code")) ||
            (service === "cloudflare-access" &&
              input.redirect_uris.some((uri) => uri !== "https://allowed.example.com/callback"));
          registrations.push({ grantTypes: input.grant_types, accepted: !refused });
          if (refused)
            return yield* HttpServerResponse.json(
              { error: "invalid_client_metadata", error_description: "PRIVATE_PROVIDER_ERROR" },
              { status: 400 },
            );
          const clientId = `synthetic-client-${registrations.length}`;
          clients.set(clientId, { secret: "synthetic-client-secret", grantTypes });
          return yield* HttpServerResponse.json(
            {
              client_id: clientId,
              client_secret: "synthetic-client-secret",
              client_secret_expires_at: 0,
              token_endpoint_auth_method: input.token_endpoint_auth_method,
              redirect_uris: input.redirect_uris,
              grant_types: grantTypes,
            },
            { status: 201 },
          );
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
            codeChallenge = params.get("code_challenge");
          if (
            clientId === null ||
            redirect === null ||
            codeChallenge === null ||
            params.get("code_challenge_method") !== "S256" ||
            !clients.has(clientId)
          )
            return HttpServerResponse.empty({ status: 400 });
          const resource = params.get("resource");
          authorizations.push({ resource });
          const callback = new URL(redirect);
          if (entra && resource !== null) {
            callback.searchParams.set("error", "invalid_target");
            callback.searchParams.set(
              "error_description",
              "AADSTS9010010: The resource parameter provided in the request doesn't match with the requested scopes.",
            );
          } else {
            const code = randomUUID();
            codes.set(code, {
              clientId,
              redirect,
              challenge: codeChallenge,
              nonce: params.get("nonce"),
              scope: params.get("scope") ?? "",
            });
            callback.searchParams.set("code", code);
          }
          callback.searchParams.set("state", params.get("state") ?? "");
          if (service === "facebook") callback.hash = "_=_";
          return HttpServerResponse.empty({ status: 302, headers: { location: callback.href } });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/token",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const contentType = request.headers["content-type"];
          tokenContentTypes.push(contentType);
          if (
            ahrefs &&
            contentType !== "application/x-www-form-urlencoded" &&
            contentType !== "application/json"
          )
            return yield* HttpServerResponse.json(
              [
                "Error",
                [
                  "InvalidInput",
                  "invalid input: expected application/json or application/x-www-form-urlencoded body",
                ],
              ],
              { status: 400 },
            );
          const input = tokenRequestParameters(contentType, yield* request.text);
          const authorization = request.headers.authorization;
          const [basicId, basicSecret] = authorization?.startsWith("Basic ")
            ? Buffer.from(authorization.slice(6), "base64")
                .toString("utf8")
                .split(":")
                .map((part) => decodeURIComponent(part))
            : [input.get("client_id"), input.get("client_secret")];
          const origin = yield* Deferred.await(address);
          const now = Math.floor(Date.now() / 1000);
          /** A signed ID token naming `tenant` in `tid`, and `issuerTenant` in `iss`. */
          const idToken = (claims: {
            clientId: string;
            tenant: string;
            issuerTenant: string;
            nonce: string | null;
          }) => {
            const jwt = [
              { alg: "RS256", kid: "synthetic-key", typ: "JWT" },
              {
                iss: `${origin}/${claims.issuerTenant}/v2.0`,
                tid: claims.tenant,
                aud: claims.clientId,
                sub: "synthetic-subject",
                iat: now,
                exp: now + 3600,
                ...(claims.nonce === null ? {} : { nonce: claims.nonce }),
              },
            ]
              .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
              .join(".");
            return `${jwt}.${sign("sha256", Buffer.from(jwt), rsaKey).toString("base64url")}`;
          };
          const refreshToken = (clientId: string) => {
            const token = `synthetic-refresh-${randomUUID()}`;
            refreshGrants.set(token, clientId);
            return token;
          };

          if (input.get("grant_type") === "refresh_token") {
            const presented = input.get("refresh_token");
            const clientId = presented === null ? undefined : refreshGrants.get(presented);
            const client = clientId === undefined ? undefined : clients.get(clientId);
            const valid =
              clientId !== undefined &&
              client !== undefined &&
              basicId === clientId &&
              basicSecret === client.secret;
            refreshes.push({ tenant: refreshTenant, issued: valid });
            if (!valid)
              return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
            // A refreshed ID token carries no nonce (OpenID Connect Core 12.2).
            const accessToken = `synthetic-refreshed-token-${refreshes.length}`;
            refreshedAccessTokens.add(accessToken);
            return yield* HttpServerResponse.json({
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: 3600,
              id_token: idToken({
                clientId,
                tenant: refreshTenant,
                issuerTenant: refreshTenant,
                nonce: null,
              }),
            });
          }

          const code = input.get("code");
          const issued = code === null ? undefined : codes.get(code);
          const client = issued === undefined ? undefined : clients.get(issued.clientId);
          const verifier = input.get("code_verifier");
          const resource = input.get("resource");
          const valid =
            issued !== undefined &&
            client !== undefined &&
            input.get("grant_type") === "authorization_code" &&
            input.get("redirect_uri") === issued.redirect &&
            basicId === issued.clientId &&
            basicSecret === client.secret &&
            verifier !== null &&
            createHash("sha256").update(verifier).digest("base64url") === issued.challenge &&
            !(entra && resource !== null);
          tokenRequests.push({ resource, issued: valid });
          if (!valid)
            return yield* HttpServerResponse.json(
              { error: entra && resource !== null ? "invalid_target" : "invalid_grant" },
              { status: 400 },
            );
          if (code !== null) codes.delete(code);
          return yield* HttpServerResponse.json({
            access_token: "synthetic-access-token",
            token_type: "Bearer",
            expires_in: exchangedExpiresIn,
            ...(client.grantTypes.includes("refresh_token")
              ? { refresh_token: refreshToken(issued.clientId) }
              : {}),
            ...(entra && issued.scope.split(" ").includes("openid")
              ? {
                  id_token: idToken({
                    clientId: issued.clientId,
                    tenant: entraTenant,
                    issuerTenant: mismatchedTenantIssuer ? otherTenant : entraTenant,
                    nonce: issued.nonce,
                  }),
                }
              : {}),
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/resource",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization ?? null;
          // Report whether a renewed token was presented, and echo the credential itself.
          return yield* HttpServerResponse.json({
            refreshed: refreshedAccessTokens.has(authorization?.replace(/^Bearer /, "") ?? ""),
            authorization,
          });
        }),
      ),
    );
    const listener = yield* Effect.sync(() => createServer());
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("OAuth fixture needs a TCP listener");
    const origin = `http://127.0.0.1:${server.address.port}`;
    yield* Deferred.succeed(address, origin);
    return {
      origin,
      /** The authorization server's issuer as protected-resource metadata names it. */
      issuer: `${origin}${issuerPath}`,
      /** Issue ID tokens whose `iss` names a different tenant than their `tid`. */
      mismatchTenantIssuer: (mismatched: boolean) =>
        Effect.sync(() => {
          mismatchedTenantIssuer = mismatched;
        }),
      /** Name this tenant in a refreshed ID token's `tid` and `iss`, keeping its `sub`. */
      refreshAsTenant: (tenant: string) =>
        Effect.sync(() => {
          refreshTenant = tenant;
        }),
      /** Lifetime of tokens from later code exchanges, in seconds. */
      exchangeExpiresIn: (seconds: number) =>
        Effect.sync(() => {
          exchangedExpiresIn = seconds;
        }),
      metrics: Effect.sync(() => ({
        discoveryRequests: [...discoveryRequests],
        authorizations: [...authorizations],
        registrations: [...registrations],
        tokenRequests: [...tokenRequests],
        tokenContentTypes: [...tokenContentTypes],
        refreshes: [...refreshes],
      })),
    };
  });
