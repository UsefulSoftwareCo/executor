/** Generated package metadata and installed labels remain independent through real imports. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Workspace } from "../support/app-authoring.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const Package = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    dependencies: Schema.Record(Schema.String, Schema.String),
  }),
);

// The upstream API is a fixture; imports still run through the complete Executor server.
const upstream = Effect.gen(function* () {
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/openapi.json",
      HttpServerResponse.json({
        openapi: "3.0.3",
        info: { title: "Package fixture", version: "1" },
        paths: {
          "/ping": {
            get: { operationId: "ping", responses: { "200": { description: "OK" } } },
          },
        },
      }),
    ),
    HttpRouter.add("GET", "/ping", HttpServerResponse.json({ ok: true })),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return `http://127.0.0.1:${server.address.port}`;
});

layer(HostedLive, { excludeTestServices: true })("App package metadata", (it) => {
  it.effect(scenarios.appPackageMetadata.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const origin = yield* upstream;
        const suffix = randomUUID().slice(0, 8);
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const fixture of [
          {
            kind: "mcp",
            name: `MCP Notes ${suffix}`,
            package: `@${actors.organization.slug}/mcp-notes-${suffix}`,
            dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
          },
          {
            kind: "graphql",
            name: `@fixture/graphql-${suffix}`,
            package: `@${actors.organization.slug}/graphql-${suffix}`,
            dependencies: { graphql: "16.11.0" },
          },
          {
            kind: "openapi",
            name: `OpenAPI Calendar ${suffix}`,
            package: `@${actors.organization.slug}/openapi-calendar-${suffix}`,
            dependencies: {},
          },
        ] as const) {
          const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source:
              fixture.kind === "openapi"
                ? {
                    kind: fixture.kind,
                    name: fixture.name,
                    url: `${origin}/openapi.json`,
                    baseUrl: origin,
                  }
                : {
                    kind: fixture.kind,
                    name: fixture.name,
                    url: `${origin}/${fixture.kind}`,
                    auth: { type: "none" },
                  },
          });
          expect(imported.status).toBe(200);
          const app = yield* body(App, imported);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
          );
          expect(app.name).toBe(fixture.name);
          const path = `${prefix}/apps/${app.id}`;
          const before = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${path}/workspace`),
          );
          const manifest = before.files.find((file) => file.path === "package.json");
          expect(manifest, `${fixture.kind} retains package metadata`).toBeDefined();
          if (manifest === undefined) return yield* Effect.die("Package manifest missing");
          const metadata = yield* Schema.decodeUnknownEffect(Package)(manifest.content);
          expect(metadata.name).toBe(fixture.package);
          expect(metadata.dependencies).toEqual(fixture.dependencies);
          const source = before.files.find((file) => file.path === "index.ts");
          expect(source?.content).not.toMatch(/\bname\s*:/);

          const renamed = yield* body(
            App,
            yield* api.request(actors.owner, "PATCH", `${path}/name`, {
              name: `My ${fixture.kind} ${suffix}`,
            }),
          );
          expect(renamed.name).toBe(`My ${fixture.kind} ${suffix}`);
          const after = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${path}/workspace`),
          );
          expect(after).toEqual(before);
          if (fixture.kind === "openapi") {
            const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "queries.ping",
              input: {},
            });
            expect(called.status).toBe(200);
            expect(called.body).toEqual({ ok: true });
          }
        }
      }),
    ),
  );
});
