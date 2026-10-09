/**
 * An MCP response is either answered and closed, or held open by the session object
 * (`subscriptions/listen`). The gateway forwards both as streams, so its spans and the platform's
 * subrequest last as long as the client listens. The request spans say whether the response is
 * held, and each body's close records how long it stayed open, so latency reads can leave held
 * streams out and their lifetime is measured on its own.
 */
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

/** How long the client keeps the subscription stream open. */
const holdMs = 3000;
const revision = "2026-07-28";
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};
/** The object's marker for a held response, which a client must never see. */
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
          // Closing a request's scope aborts its response, so a listening client really leaves.
          const client = HttpClient.withScope(http);
          /** One stateless MCP request under its own trace. */
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

          // The client listens, then leaves; the object notices at the stream's next write.
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

          /**
           * A trace's request spans and stream closes, once the side named by `phase` has closed.
           * The object notices the departed client at its stream's next write, and an isolate
           * exports ended spans with its next request's flush (packages/telemetry/src/isolate.ts),
           * so each attempt sends one more request on the same session object.
           */
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
                  : Effect.fail(new Error("The request's spans have not reached Motel"));
              }),
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 75 }),
            );
          const tags = (span: Span | undefined) => span?.tags ?? {};
          const listen = yield* spans(listened.traceId, "session");
          const buffered = yield* spans(listed, "gateway");
          yield* evidence.json("spans.json", { listen, buffered });

          // The held stream: both request spans say so, and its close records its lifetime.
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
          // The gateway's close of the same stream can wait for a later export (C-033); when it
          // has arrived it agrees.
          if (listen.gateway !== undefined)
            expect(tags(listen.gateway)["executor.mcp.stream.held"]).toBe("true");
          // The buffered answer: not held, closed once its body is sent, with no object stream.
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
