/** An operation whose security also allows no credentials is still called with the chosen account. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { openapiAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const ok = {
  "200": {
    description: "Whether the request carried the account's token",
    content: { "application/json": { schema: { type: "object" } } },
  },
};

layer(HostedLive, { excludeTestServices: true })("OpenAPI optional security", (it) => {
  it.effect(scenarios.openapiOptionalSecurity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const whoami = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization;
          if (authorization !== undefined && authorization !== "Bearer synthetic-token")
            return HttpServerResponse.empty({ status: 401 });
          return yield* HttpServerResponse.json({ signedIn: authorization !== undefined });
        });
        const routes = Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/openapi.json",
            HttpServerResponse.json({
              openapi: "3.0.3",
              info: { title: "Optional security fixture", version: "1" },
              components: {
                securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
              },
              paths: {
                // The anonymous alternative listed first, and then last.
                "/public-first": {
                  get: {
                    tags: ["auth"],
                    operationId: "publicFirst",
                    security: [{}, { bearer: [] }],
                    responses: ok,
                  },
                },
                "/public-last": {
                  get: {
                    tags: ["auth"],
                    operationId: "publicLast",
                    security: [{ bearer: [] }, {}],
                    responses: ok,
                  },
                },
              },
            }),
          ),
          HttpRouter.add("GET", "/public-first", whoami),
          HttpRouter.add("GET", "/public-last", whoami),
        );
        const services = yield* Layer.build(
          HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
        const origin = `http://127.0.0.1:${server.address.port}`;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Optional security proof",
          files: openapiAppFiles("Optional security proof", {
            url: `${origin}/openapi.json`,
            allowedOrigin: origin,
            baseUrl: origin,
            securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
            key: "bearer",
          }),
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        const path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            if (account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        account = (yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "apiKey", label: "Synthetic token", fields: { token: "synthetic-token" } },
          ),
        )).id;
        for (const tool of ["publicFirst", "publicLast"]) {
          const result = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: `auth.${tool}`,
            kind: "query",
            input: { accountId: account, input: {} },
          });
          yield* evidence.json(`${tool}.json`, result);
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          const answer = yield* body(Schema.Struct({ signedIn: Schema.Boolean }), result);
          expect(answer, tool).toEqual({ signedIn: true });
        }
      }),
    ),
  );
});
