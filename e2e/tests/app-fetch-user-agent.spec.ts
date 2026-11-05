/**
 * App code's own `fetch` goes out through Executor's outbound network. Workers send no User-Agent,
 * and GitHub's API refuses a request without one, so the outbound names Executor when app code
 * names no client and keeps the one it does.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { Evidence } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

const token = "synthetic-user-agent-token";

const Health = Schema.Struct({
  info: Schema.NullOr(Schema.Struct({ username: Schema.optional(Schema.String) })),
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(
        Schema.Struct({ status: Schema.String, message: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});

/**
 * The check reads the current user as GitHub's catalog app does, naming no client. The tool sends
 * the User-Agent it is given, or none, and returns the one the service saw.
 */
const source = (origin: string) => `import {
  decodeJson, defineApp, defineProvider, object, query, router, secrets, string,
} from "apps";
const User = object({ login: string() });
const Client = object({ userAgent: string() });
const service = defineProvider({
  name: "User-Agent service",
  auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) },
  async health({ account, fetch, signal }) {
    const response = await fetch(${JSON.stringify(`${origin}/user`)}, {
      signal,
      headers: { Authorization: "Bearer " + account.fields.token, Accept: "application/json" },
    });
    const me = await decodeJson(response, User);
    return { accountInfo: { username: me.login } };
  },
});
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    client: query({ input: object({ userAgent: string().optional() }) }, async (_ctx, { userAgent }) => {
      const response = await fetch(${JSON.stringify(`${origin}/client`)}, {
        headers: userAgent === undefined ? {} : { "User-Agent": userAgent },
      });
      return decodeJson(response, Client);
    }),
  }),
});`;

layer(HostedLive, { excludeTestServices: true })("App fetch User-Agent", (it) => {
  it.effect(scenarios.appFetchUserAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        // Answers as GitHub's API does: 403 with an HTML page for a request without a User-Agent.
        const identified = (
          respond: (
            request: HttpServerRequest.HttpServerRequest,
            userAgent: string,
          ) => ReturnType<typeof HttpServerResponse.json>,
        ) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const userAgent = request.headers["user-agent"];
            if (!userAgent)
              return HttpServerResponse.text(
                "Request forbidden by administrative rules. Please make sure your request has a User-Agent header",
                { status: 403, contentType: "text/html; charset=utf-8" },
              );
            return yield* respond(request, userAgent);
          });
        const routes = Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/user",
            identified((request) =>
              request.headers.authorization === `Bearer ${token}`
                ? HttpServerResponse.json({ login: "synthetic-user" })
                : HttpServerResponse.json({ message: "Bad credentials" }, { status: 401 }),
            ),
          ),
          HttpRouter.add(
            "GET",
            "/client",
            identified((_request, userAgent) => HttpServerResponse.json({ userAgent })),
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
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "User-Agent proof",
          files: [{ path: "index.ts", content: source(origin) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
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
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "token", fields: { token } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        account = (yield* body(Resource, saved)).id;

        // The check that names no client passes and reports the service's username.
        const checked = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/accounts/${account}/health`,
        );
        yield* evidence.json("health.json", checked);
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        const health = yield* body(Health, checked);
        const check = health.apps.find((entry) => entry.app === app.id)?.check;
        expect(check?.status, JSON.stringify(check)).toBe("healthy");
        expect(health.info?.username).toBe("synthetic-user");

        // A tool's request names Executor by default and keeps the client app code names.
        for (const userAgent of [undefined, "Custom client/1.0"]) {
          const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "client",
            kind: "query",
            input: userAgent === undefined ? {} : { userAgent },
          });
          yield* evidence.json(
            userAgent === undefined ? "default-client.json" : "custom-client.json",
            called,
          );
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          expect(yield* body(Schema.Struct({ userAgent: Schema.String }), called)).toEqual({
            userAgent: userAgent ?? "Executor",
          });
        }
      }),
    ),
  );
});
