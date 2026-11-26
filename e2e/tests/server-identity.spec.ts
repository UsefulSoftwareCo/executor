import { expect, layer } from "@effect/vitest";
import { request } from "node:http";
import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const Identity = Schema.Struct({
  serverId: Schema.String,
  kind: Schema.Literals(["local", "self-host", "cloud"]),
  origins: Schema.Struct({ dashboard: Schema.String, api: Schema.String, auth: Schema.String }),
});

layer(TestLive, { excludeTestServices: true })("Server identity", (it) => {
  it.effect(scenarios.serverIdentity.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const target = yield* Target;
        const origin = targetHosts(target).browser;
        const readAt = (at: string) =>
          http.get(`${at}/.well-known/executor`).pipe(
            Effect.flatMap((response) =>
              Effect.map(response.json, (json) => ({
                status: response.status,
                cacheControl: response.headers["cache-control"],
                setCookie: response.headers["set-cookie"],
                json,
              })),
            ),
          );
        const read = readAt(origin);
        const first = yield* read;
        expect(first.status).toBe(200);
        expect(first.cacheControl).toBe(
          target.metadata.target === "local" ? "no-store" : "public, max-age=300",
        );
        expect(first.setCookie).toBeUndefined();
        const fields = yield* Schema.decodeUnknownEffect(
          Schema.Record(Schema.String, Schema.Unknown),
        )(first.json);
        expect(Object.keys(fields).toSorted()).toEqual(["kind", "origins", "serverId"]);
        const identity = yield* Schema.decodeUnknownEffect(Identity)(first.json);
        expect(identity.kind).toBe(target.metadata.target);
        expect(identity.serverId).toMatch(new RegExp(`^${identity.kind}-[0-9a-f]{32}$`, "u"));
        const second = yield* read;
        expect(second.json).toEqual(first.json);
        const hosts = targetHosts(target);
        expect(identity.origins).toEqual({
          dashboard: hosts.browser,
          api: hosts.api,
          auth: hosts.edge,
        });
        if (hosts.deployment !== origin)
          expect((yield* readAt(hosts.deployment)).json).toEqual(first.json);
        const roleHosts = [hosts.api, hosts.mcp].filter((host) => host !== origin);
        const served = yield* Effect.forEach(roleHosts, (host) =>
          http
            .get(`${host}/.well-known/executor`)
            .pipe(
              Effect.map((response) => [new URL(host).hostname.split(".")[0], response.status]),
            ),
        );
        if (target.metadata.target === "local") {
          const at = new URL(origin);
          const foreign = yield* Effect.callback<number | undefined, Error>((resume) => {
            const sent = request(
              {
                host: at.hostname,
                port: at.port,
                path: "/.well-known/executor",
                headers: { host: `evil.example:${at.port}` },
              },
              (response) => {
                response.resume();
                resume(Effect.succeed(response.statusCode));
              },
            );
            sent.once("error", (error) => resume(Effect.fail(error)));
            sent.end();
          });
          expect(foreign).toBe(403);
        }
        expect(served).toEqual(
          target.metadata.target === "cloud"
            ? [
                ["api", 404],
                ["mcp", 404],
              ]
            : [],
        );
      }),
    ),
  );
});
