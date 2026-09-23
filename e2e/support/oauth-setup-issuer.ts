/** A scoped external OAuth issuer for setup checks; Executor still uses its real HTTP and storage paths. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** Start a loopback issuer with controllable discovery and registration metadata. */
export const oauthSetupIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  let registration = true;
  let expiresAt = 0;
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
      "/mcp",
      Effect.gen(function* () {
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
    HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", resource),
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
          scopes_supported: scopes,
          ...(registration ? { registration_endpoint: `${origin}/register` } : {}),
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
        return yield* HttpServerResponse.json(
          {
            client_id: `synthetic-client-${registrations}`,
            client_secret: "synthetic-client-secret",
            client_secret_expires_at: expiresAt,
            token_endpoint_auth_method: input.token_endpoint_auth_method,
            redirect_uris: input.redirect_uris,
          },
          { status: 201 },
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
      readonly expiresAt?: number;
      readonly discovery?: typeof discovery;
      readonly scopes?: readonly string[];
      readonly authMethods?: readonly string[];
    }) =>
      Effect.sync(() => {
        if (input.registration !== undefined) registration = input.registration;
        if (input.expiresAt !== undefined) expiresAt = input.expiresAt;
        if (input.discovery !== undefined) discovery = input.discovery;
        if (input.scopes !== undefined) scopes = [...input.scopes];
        if (input.authMethods !== undefined) authMethods = [...input.authMethods];
      }),
    metrics: Effect.sync(() => ({ registrations, discoveries, lastRegistration })),
  };
});
