/**
 * Remote MCP servers emulating the authorization patterns real services use. Each pattern is
 * its own loopback origin, so path-suffixed and root well-known metadata stay independent.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

/**
 * - `anonymous`: initialize and tools/list work without credentials; nothing about OAuth.
 * - `anonymous-oauth`: works anonymously over SSE and also publishes OAuth metadata (Exa).
 * - `oauth-dcr`: rejects anonymous use; OAuth with dynamic client registration.
 * - `oauth-manual`: rejects anonymous use; its authorization server registers no clients (GitHub).
 * - `challenge-only`: the only metadata is the document its challenge names.
 * - `scopes-provided`: root metadata lists scopes as `scopes_provided` (Ahrefs).
 * - `dcr-rejects-redirect`: registration refuses Executor's callback (Fastmail).
 * - `client-auth-unsupported`: the token endpoint accepts only `private_key_jwt` clients.
 * - `pkce-unadvertised`: authorization-server metadata lists no PKCE methods but the server
 *   accepts S256, as Microsoft Entra ID does.
 * - `pkce-plain`: authorization-server metadata lists only the `plain` PKCE method.
 * - `bearer-key`: a Bearer challenge and no OAuth anywhere: an API key.
 * - `initialize-fails`: initialize answers with a JSON-RPC error.
 * - `refused`: a firewall answers every request with a 403 page.
 */
export type McpAuthPattern =
  | "anonymous"
  | "anonymous-oauth"
  | "oauth-dcr"
  | "oauth-manual"
  | "challenge-only"
  | "scopes-provided"
  | "dcr-rejects-redirect"
  | "client-auth-unsupported"
  | "pkce-unadvertised"
  | "pkce-plain"
  | "bearer-key"
  | "initialize-fails"
  | "refused";

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});

const page = (status: number) =>
  HttpServerResponse.text("<html><body>Request blocked</body></html>", {
    status,
    contentType: "text/html",
  });

/** Start one pattern's server; the listener closes with the caller's scope. */
export const mcpAuthServer = Effect.fn(function* (pattern: McpAuthPattern) {
  const address = yield* Deferred.make<string>();
  let registrations = 0;
  const origin = Deferred.await(address);
  const anonymous = pattern === "anonymous" || pattern === "anonymous-oauth";
  /** Patterns with an authorization server, and those that publish path-suffixed metadata. */
  const oauth = !["anonymous", "bearer-key", "initialize-fails", "refused"].includes(pattern);
  const pathMetadata = [
    "anonymous-oauth",
    "oauth-dcr",
    "oauth-manual",
    "dcr-rejects-redirect",
    "client-auth-unsupported",
    "pkce-unadvertised",
    "pkce-plain",
  ];
  /** Ahrefs names its origin, with a trailing slash, as both resource and issuer. */
  const issuer = (base: string) => (pattern === "scopes-provided" ? `${base}/` : base);
  const resource = Effect.gen(function* () {
    const base = yield* origin;
    return yield* HttpServerResponse.json({
      resource: pattern === "scopes-provided" ? `${base}/` : `${base}/mcp`,
      authorization_servers: [issuer(base)],
      ...(pattern === "scopes-provided"
        ? { scopes_provided: ["apiv3-mcp"] }
        : { scopes_supported: ["mcp:tools"] }),
    });
  });
  const challenge = Effect.gen(function* () {
    const base = yield* origin;
    if (pattern === "refused") return page(403);
    if (pattern === "bearer-key")
      return HttpServerResponse.text("API key required", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="api"' },
      });
    const metadata =
      pattern === "challenge-only"
        ? `${base}/auth/resource`
        : pattern === "scopes-provided"
          ? `${base}/.well-known/oauth-protected-resource`
          : `${base}/.well-known/oauth-protected-resource/mcp`;
    return HttpServerResponse.text("Sign in required", {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
    });
  });
  const answer = (id: number | string, body: object) =>
    pattern === "anonymous-oauth"
      ? Effect.succeed(
          HttpServerResponse.text(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n\n`,
            {
              contentType: "text/event-stream",
              headers: { "mcp-session-id": "synthetic-session" },
            },
          ),
        )
      : HttpServerResponse.json({ jsonrpc: "2.0", id, ...body });
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 405 }))),
    HttpRouter.add("DELETE", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        if (!anonymous && pattern !== "initialize-fails") return yield* challenge;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Message)),
          Effect.orDie,
        );
        if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
        if (pattern === "initialize-fails")
          return yield* answer(message.id, {
            error: { code: -32602, message: "Unsupported protocol version" },
          });
        return yield* answer(
          message.id,
          message.method === "initialize"
            ? {
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: `synthetic-${pattern}`, version: "1" },
                },
              }
            : {
                result: {
                  tools: [
                    {
                      name: "search",
                      description: "Search synthetic records",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                },
              },
        );
      }),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      Effect.suspend(() =>
        pattern === "refused"
          ? Effect.succeed(page(403))
          : pathMetadata.includes(pattern)
            ? resource
            : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-protected-resource",
      Effect.suspend(() =>
        pattern === "refused"
          ? Effect.succeed(page(403))
          : pattern === "scopes-provided"
            ? resource
            : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/auth/resource",
      Effect.suspend(() =>
        pattern === "challenge-only"
          ? resource
          : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        if (pattern === "refused") return page(403);
        if (!oauth) return HttpServerResponse.empty({ status: 404 });
        const base = yield* origin;
        return yield* HttpServerResponse.json({
          issuer: issuer(base),
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          ...(pattern === "pkce-unadvertised"
            ? {}
            : {
                code_challenge_methods_supported: pattern === "pkce-plain" ? ["plain"] : ["S256"],
              }),
          token_endpoint_auth_methods_supported:
            pattern === "client-auth-unsupported" ? ["private_key_jwt"] : ["none"],
          ...(pattern === "oauth-manual" ? {} : { registration_endpoint: `${base}/register` }),
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/register",
      Effect.gen(function* () {
        registrations++;
        if (pattern === "dcr-rejects-redirect")
          return yield* HttpServerResponse.json(
            { error: "invalid_redirect_uri", error_description: "Redirect URI not allowed" },
            { status: 400 },
          );
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ redirect_uris: Schema.Array(Schema.String) }),
            ),
          ),
          Effect.orDie,
        );
        return yield* HttpServerResponse.json(
          {
            client_id: `synthetic-${pattern}-client`,
            token_endpoint_auth_method: "none",
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
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  const base = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, base);
  return {
    origin: base,
    url: `${base}/mcp`,
    /** Dynamic client registration requests received. */
    registrations: Effect.sync(() => registrations),
  };
});
