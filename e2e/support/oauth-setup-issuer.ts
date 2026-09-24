/** A scoped external OAuth issuer for setup checks; Executor still uses its real HTTP and storage paths. */
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** The client metadata URL self-host e2e servers are configured with. */
export const e2eClientMetadataUrl =
  "https://executor.example/api/oauth/client-id-metadata/default.json";

/** Start a loopback issuer with controllable discovery and registration metadata. */
export const oauthSetupIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  let registration = true;
  let clientIdMetadata = false;
  let lastRedirect: string | undefined;
  let postChallenge = false;
  let challenge = true;
  let probes = 0;
  let mcpStatus: 520 | undefined;
  let expiresAt = 0;
  let registrationStatus: 200 | 201 | 400 = 201;
  let malformedRegistration = false;
  let registrationError: "invalid_client_metadata" | "invalid_redirect_uri" =
    "invalid_client_metadata";
  let omitSecretExpiry = false;
  let nonceRequested: boolean | undefined;
  let idTokenAlgorithms: readonly string[] | undefined;
  let includeIdToken = false;
  let invalidNonce = false;
  let tokenExchanges = 0;
  let tokenChecks: Readonly<Record<string, boolean>> = {};
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const clients = new Map<string, readonly string[]>();
  const codes = new Map<
    string,
    { clientId: string; redirect: string; challenge: string; nonce: string | null }
  >();
  let discovery:
    | "available"
    | "unavailable"
    | "missing"
    | "no-oauth"
    | "invalid-json"
    | "invalid-metadata"
    | "blocked" = "available";
  let scopes = ["read"];
  let registrations = 0;
  let discoveries = 0;
  let authMethods = ["client_secret_basic"];
  let lastRegistration: { scope: string; method: string } | undefined;
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
          !(
            (clientIdMetadata && clientId === e2eClientMetadataUrl) ||
            clients.get(clientId)?.includes(redirect)
          )
        )
          return HttpServerResponse.empty({ status: 400 });
        lastRedirect = redirect;
        const code = randomUUID();
        nonceRequested = params.get("nonce") !== null;
        codes.set(code, { clientId, redirect, challenge, nonce: params.get("nonce") });
        const callback = new URL(redirect);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", params.get("state") ?? "");
        return HttpServerResponse.empty({ status: 302, headers: { location: callback.href } });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        tokenExchanges++;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = new URLSearchParams(yield* request.text);
        const code = input.get("code"),
          verifier = input.get("code_verifier");
        const issued = code === null ? undefined : codes.get(code);
        const authorization = request.headers.authorization;
        const decoded = authorization?.startsWith("Basic ")
          ? Buffer.from(authorization.slice(6), "base64").toString("utf8")
          : "";
        const separator = decoded.indexOf(":");
        const username =
          separator < 0
            ? undefined
            : decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " "));
        const password =
          separator < 0
            ? undefined
            : decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " "));
        const common = {
          issued: issued !== undefined,
          grant: input.get("grant_type") === "authorization_code",
          redirect: issued !== undefined && input.get("redirect_uri") === issued.redirect,
          pkce:
            issued !== undefined &&
            verifier !== null &&
            createHash("sha256").update(verifier).digest("base64url") === issued.challenge,
        };
        tokenChecks =
          issued?.clientId === e2eClientMetadataUrl
            ? {
                ...common,
                publicClient: authorization === undefined,
                bodyClient: input.get("client_id") === issued.clientId,
              }
            : {
                ...common,
                authHeader: authorization !== undefined,
                authScheme: authorization?.startsWith("Basic ") === true,
                authClient: issued !== undefined && username === issued.clientId,
                authSecret: password === "synthetic-client-secret",
              };
        if (issued === undefined || code === null || !Object.values(tokenChecks).every(Boolean))
          return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(code);
        const origin = yield* Deferred.await(address);
        const now = Math.floor(Date.now() / 1000);
        const jwt = [
          { alg: "ES256", kid: "synthetic-key", typ: "JWT" },
          {
            iss: origin,
            aud: issued.clientId,
            sub: "synthetic-subject",
            iat: now,
            exp: now + 3600,
            ...(issued.nonce === null
              ? {}
              : { nonce: invalidNonce ? "wrong-nonce" : issued.nonce }),
          },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
          .join(".");
        const signature = sign("sha256", Buffer.from(jwt), {
          key: keyPair.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return yield* HttpServerResponse.json({
          access_token: "synthetic-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          ...(includeIdToken ? { id_token: `${jwt}.${signature}` } : {}),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/invalid-openapi",
      HttpServerResponse.json({
        openapi: "2.0.0",
        info: { title: "PRIVATE_SPEC_CONTENT", version: "1" },
        paths: {},
      }),
    ),
    HttpRouter.add(
      "GET",
      "/mcp",
      Effect.gen(function* () {
        probes++;
        if (mcpStatus !== undefined) return HttpServerResponse.empty({ status: mcpStatus });
        if (postChallenge) return HttpServerResponse.empty({ status: 405 });
        if (discovery === "no-oauth") return HttpServerResponse.empty({ status: 200 });
        const origin = yield* Deferred.await(address);
        return HttpServerResponse.empty({
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
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
        const origin = yield* Deferred.await(address);
        return HttpServerResponse.empty({
          status: 401,
          headers: challenge
            ? {
                "www-authenticate": `Bearer resource_metadata="${origin}/challenge-resource"`,
              }
            : {},
        });
      }),
    ),
    HttpRouter.add("GET", "/challenge-resource", resource),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      Effect.suspend(() =>
        postChallenge ? Effect.succeed(HttpServerResponse.empty({ status: 404 })) : resource,
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        discoveries++;
        if (discovery === "unavailable") return HttpServerResponse.empty({ status: 503 });
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
          ...(clientIdMetadata ? { client_id_metadata_document_supported: true } : {}),
          ...(registration
            ? { registration_endpoint: `${origin}/register?fixture=PRIVATE_QUERY` }
            : {}),
        });
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
              }),
            ),
          ),
        );
        lastRegistration = { scope: input.scope ?? "", method: input.token_endpoint_auth_method };
        if (registrationStatus === 400)
          return yield* HttpServerResponse.json(
            {
              error: registrationError,
              error_description: "PRIVATE_PROVIDER_ERROR",
            },
            { status: 400 },
          );
        if (!malformedRegistration)
          clients.set(`synthetic-client-${registrations}`, input.redirect_uris);
        return yield* HttpServerResponse.json(
          {
            ...(malformedRegistration ? {} : { client_id: `synthetic-client-${registrations}` }),
            client_secret: "synthetic-client-secret",
            ...(omitSecretExpiry ? {} : { client_secret_expires_at: expiresAt }),
            token_endpoint_auth_method: input.token_endpoint_auth_method,
            redirect_uris: input.redirect_uris,
          },
          { status: registrationStatus },
        );
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("OAuth fixture needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, origin);
  return {
    origin,
    configure: (input: {
      readonly registration?: boolean;
      readonly clientIdMetadata?: boolean;
      readonly registrationStatus?: typeof registrationStatus;
      readonly malformedRegistration?: boolean;
      readonly registrationError?: typeof registrationError;
      readonly omitSecretExpiry?: boolean;
      readonly idTokenAlgorithms?: readonly string[];
      readonly includeIdToken?: boolean;
      readonly invalidNonce?: boolean;
      readonly postChallenge?: boolean;
      readonly challenge?: boolean;
      readonly mcpStatus?: 520 | null;
      readonly expiresAt?: number;
      readonly discovery?: typeof discovery;
      readonly scopes?: readonly string[];
      readonly authMethods?: readonly string[];
    }) =>
      Effect.sync(() => {
        if (input.mcpStatus !== undefined)
          mcpStatus = input.mcpStatus === null ? undefined : input.mcpStatus;
        if (input.postChallenge !== undefined) postChallenge = input.postChallenge;
        if (input.challenge !== undefined) challenge = input.challenge;
        if (input.idTokenAlgorithms !== undefined) idTokenAlgorithms = input.idTokenAlgorithms;
        if (input.includeIdToken !== undefined) includeIdToken = input.includeIdToken;
        if (input.invalidNonce !== undefined) invalidNonce = input.invalidNonce;
        if (input.registrationStatus !== undefined) registrationStatus = input.registrationStatus;
        if (input.malformedRegistration !== undefined)
          malformedRegistration = input.malformedRegistration;
        if (input.registrationError !== undefined) registrationError = input.registrationError;
        if (input.omitSecretExpiry !== undefined) omitSecretExpiry = input.omitSecretExpiry;
        if (input.registration !== undefined) registration = input.registration;
        if (input.clientIdMetadata !== undefined) clientIdMetadata = input.clientIdMetadata;
        if (input.expiresAt !== undefined) expiresAt = input.expiresAt;
        if (input.discovery !== undefined) discovery = input.discovery;
        if (input.scopes !== undefined) scopes = [...input.scopes];
        if (input.authMethods !== undefined) authMethods = [...input.authMethods];
      }),
    metrics: Effect.sync(() => ({
      registrations,
      discoveries,
      lastRegistration,
      lastRedirect,
      probes,
      tokenExchanges,
      tokenChecks,
      nonceRequested,
    })),
  };
});
