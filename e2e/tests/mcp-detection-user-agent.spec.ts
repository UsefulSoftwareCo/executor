import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";

const Imported = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Setup = Schema.Struct({ mode: Schema.String });

const userAgentOAuthServer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const base = yield* Deferred.await(address);
    const path = new URL(request.url, base).pathname;
    const userAgent = request.headers["user-agent"];
    if (path === "/mcp") yield* Ref.update(seen, (agents) => [...agents, userAgent]);
    if (!userAgent)
      return HttpServerResponse.text("<html><body>Request blocked</body></html>", {
        status: 403,
        contentType: "text/html",
      });
    if (path === "/mcp" && request.method === "DELETE")
      return HttpServerResponse.empty({ status: 204 });
    if (path === "/mcp")
      return HttpServerResponse.text("Sign in required", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${base}/auth/resource"` },
      });
    if (path === "/auth/resource")
      return yield* HttpServerResponse.json({
        resource: `${base}/mcp`,
        authorization_servers: [`${base}/auth`],
        scopes_supported: ["mcp:tools"],
      });
    if (path === "/.well-known/oauth-authorization-server/auth")
      return yield* HttpServerResponse.json({
        issuer: `${base}/auth`,
        authorization_endpoint: `${base}/auth/authorize`,
        token_endpoint: `${base}/auth/token`,
        registration_endpoint: `${base}/auth/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    return HttpServerResponse.empty({ status: 404 });
  });
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("*", "/*", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  const base = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, base);
  return { url: `${base}/mcp`, seen: Ref.get(seen) };
});

layer(HostedLive, { excludeTestServices: true })("MCP detection User-Agent", (it) => {
  it.effect(scenarios.mcpDetectionUserAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const server = yield* userAgentOAuthServer;
        const prefix = `/api/organizations/${actors.organization.id}`;

        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "mcp", name: `User-Agent ${randomUUID().slice(0, 8)}`, url: server.url },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(Imported, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const service = app.requirements.accounts.service;
        if (service === undefined) return yield* Effect.die("The OAuth app declares no account");

        const setup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/providers/${service.provider}/oauth/oauth/setup`,
        );
        expect(setup.status, JSON.stringify(setup.body)).toBe(200);
        expect((yield* body(Setup, setup)).mode).toBe("automatic");

        const seen = yield* server.seen;
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(new Set(seen)).toEqual(new Set(["Executor"]));
      }),
    ),
  );
});
