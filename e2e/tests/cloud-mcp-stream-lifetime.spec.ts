import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const holdMs = 3000;
const revision = "2026-07-28";
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const internal = "x-executor-session-stream";

layer(HostedLive, { excludeTestServices: true })("Cloud MCP stream lifetime", (it) => {
  it.effect(
    scenarios.cloudMcpStreamLifetime.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target,
            http = yield* HttpClient.HttpClient;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Stream lifetime",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const client = HttpClient.withScope(http);
          const raw = (method: string, params: Readonly<Record<string, unknown>>) =>
            Effect.gen(function* () {
              const traceId = randomBytes(16).toString("hex");
              const request = HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
                HttpClientRequest.bearerToken(Redacted.value(key.key)),
                HttpClientRequest.setHeaders({
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                  "mcp-protocol-version": revision,
                  "mcp-method": method,
                  "x-executor-organization": actors.organization.id,
                  traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                }),
              );
              const response = yield* client.execute(
                yield* HttpClientRequest.bodyJson(request, {
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  params: { ...params, _meta: requestMeta },
                }),
              );
              const exposed = Object.keys(response.headers).filter(
                (name) => name.toLowerCase() === internal,
              );
              expect(exposed, "The response carries no internal header").toEqual([]);
              return { traceId, response };
            }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

          const listened = yield* Effect.scoped(
            Effect.gen(function* () {
              const listen = yield* raw("subscriptions/listen", {
                notifications: { toolsListChanged: true },
              });
              expect(listen.response.status).toBe(200);
              yield* Effect.sleep(holdMs);
              return { traceId: listen.traceId, leftAt: yield* Clock.currentTimeMillis };
            }),
          );
          const list = Effect.scoped(
            raw("tools/list", {}).pipe(
              Effect.tap(({ response }) => response.text),
              Effect.map(({ traceId }) => traceId),
            ),
          );
          const listed = yield* list;

          const spans = (trace: string, phase: "gateway" | "session") =>
            list.pipe(
              Effect.andThen(telemetry.query(trace)),
              Effect.map((result) => result.data.map(({ span }) => span)),
              Effect.flatMap((spans) => {
                const close = (side: string) =>
                  spans.find(
                    (span) =>
                      span.operationName === "mcp.stream.close" &&
                      span.tags["executor.mcp.stream.phase"] === side,
                  );
                const named = (name: string) => spans.find((span) => span.operationName === name);
                const found = {
                  forward: named("mcp.session.forward"),
                  request: named("mcp.session.request"),
                  gateway: close("gateway"),
                  session: close("session"),
                };
                return found.forward && found.request && found[phase]
                  ? Effect.succeed(found)
                  : Effect.fail(new Error("The request's spans have not reached the collector"));
              }),
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 75 }),
            );
          const tags = (span: Span | undefined) => span?.tags ?? {};
          const listen = yield* spans(listened.traceId, "session");
          const buffered = yield* spans(listed, "gateway");
          yield* evidence.json("spans.json", { listen, buffered });

          expect(tags(listen.forward)["executor.mcp.response.held"]).toBe("true");
          expect(tags(listen.request)["executor.mcp.response.held"]).toBe("true");
          expect(tags(listen.session)["executor.mcp.stream.held"]).toBe("true");
          expect(
            Number(tags(listen.session)["executor.mcp.stream.open_ms"]),
            "The object's close covers the time the client listened",
          ).toBeGreaterThanOrEqual(holdMs);
          expect(
            Date.parse(listen.forward?.startTime ?? "") + (listen.forward?.durationMs ?? Infinity),
            "The forward ends when the stream starts, while the client still listens",
          ).toBeLessThan(listened.leftAt);
          if (listen.gateway !== undefined)
            expect(tags(listen.gateway)["executor.mcp.stream.held"]).toBe("true");
          expect(tags(buffered.forward)["executor.mcp.response.held"]).toBe("false");
          expect(tags(buffered.request)["executor.mcp.response.held"]).toBe("false");
          expect(tags(buffered.gateway)["executor.mcp.stream.held"]).toBe("false");
          expect(
            Number(tags(buffered.gateway)["executor.mcp.stream.open_ms"]),
            "The buffered body's time after its headers is recorded",
          ).toBeGreaterThanOrEqual(0);
          expect(buffered.session, "A buffered answer has no stream on the object").toBeUndefined();
        }),
      ),
    { timeout: 180_000 },
  );
});
