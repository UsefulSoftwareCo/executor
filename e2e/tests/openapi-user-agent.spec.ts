/** GitHub-style REST requirements are exercised through an imported app in the real Worker. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { openapiAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";

layer(HostedLive, { excludeTestServices: true })("OpenAPI User-Agent", (it) => {
  it.effect(scenarios.openapiUserAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const routes = Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/openapi.json",
            HttpServerResponse.json({
              openapi: "3.0.3",
              info: { title: "GitHub-style REST fixture", version: "1" },
              components: {
                securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
              },
              security: [{ bearer: [] }],
              paths: {
                "/user": {
                  get: {
                    operationId: "currentUser",
                    parameters: [{ name: "User-Agent", in: "header", schema: { type: "string" } }],
                    responses: {
                      "200": {
                        description: "Current account and client identifier",
                        content: { "application/json": { schema: { type: "object" } } },
                      },
                    },
                  },
                },
              },
            }),
          ),
          HttpRouter.add(
            "GET",
            "/user",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== "Bearer synthetic-github-pat")
                return HttpServerResponse.empty({ status: 401 });
              const userAgent = request.headers["user-agent"];
              if (!userAgent) return HttpServerResponse.empty({ status: 403 });
              return yield* HttpServerResponse.json({ login: "synthetic-user", userAgent });
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
        const origin = `http://127.0.0.1:${server.address.port}`;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "GitHub REST User-Agent proof",
          files: openapiAppFiles("GitHub REST User-Agent proof", {
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
        let profile: string | undefined;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (profile !== undefined)
              yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profile}`);
            yield* api.request(actors.owner, "DELETE", path);
            if (account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        profile = (yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: { service: [] },
            idempotencyKey: randomUUID(),
          }),
        )).id;
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile,
          }),
        );
        account = (yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "apiKey",
              label: "Synthetic PAT",
              fields: { token: "synthetic-github-pat" },
            },
          ),
        )).id;
        for (const userAgent of [undefined, "Custom REST client"]) {
          const result = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile,
            tool: "queries.currentUser",
            input: {
              accountId: account,
              input: userAgent === undefined ? {} : { headers: { "User-Agent": userAgent } },
            },
          });
          yield* evidence.json(
            userAgent === undefined ? "default-client.json" : "custom-client.json",
            result,
          );
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          const resultBody = yield* body(
            Schema.Struct({ login: Schema.String, userAgent: Schema.String }),
            result,
          );
          expect(resultBody).toEqual({
            login: "synthetic-user",
            userAgent: userAgent ?? "Executor",
          });
        }
      }),
    ),
  );
});
