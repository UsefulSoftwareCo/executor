/**
 * Cloud builds its span and log exporters once per isolate and exports what they hold on demand:
 * the first item buffered after a flush arms one timer, which keeps the event that armed it alive
 * until it has exported, and every event's close exports the rest
 * (`packages/telemetry/src/isolate.ts`). An isolate whose listen streams are idle therefore runs no
 * telemetry work, where it once flushed every second for each open stream. Each session request
 * records how many flushes its isolate has run, so two requests on either side of an idle wait show
 * the work done between them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

/** Listen streams held open on the one session object. */
const listens = 3;
/** How long the streams stay idle, with no request, between the two counted requests. */
const idleMs = 12_000;
const revision = "2026-07-28";
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const flushesAttribute = "executor.telemetry.isolate.flushes";

/** The scenario's API key, deleted when the scenario ends, and its MCP requests. */
const session = (name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    // Closing a request's scope aborts its response, so a listening client really leaves.
    const client = HttpClient.withScope(http);
    /** One stateless MCP request under its own trace; every one reaches the key's object. */
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
        return { traceId, response };
      }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return { raw };
  });

/** A trace's span named `name`, once the collector has it. Reading it sends the server nothing. */
const delivered = (traceId: string, name: string, attempts: number) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.query(traceId).pipe(
      Effect.map((result) => result.data.map(({ span }) => span)),
      Effect.flatMap((spans) => {
        const found = spans.find((span) => span.operationName === name);
        return found === undefined
          ? Effect.fail(new Error(`${name} has not reached the collector`))
          : Effect.succeed(found);
      }),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: attempts }),
    );
  });

layer(HostedLive, { excludeTestServices: true })("Cloud's isolate telemetry flush", (it) => {
  it.effect(
    scenarios.cloudTelemetryIdleFlush.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const { raw } = yield* session("Idle flush");
          /** A buffered request, and how many flushes its isolate had run when it started. */
          const counted = Effect.scoped(
            raw("tools/list", {}).pipe(
              Effect.tap(({ response }) => response.text),
              // The request's close exports its spans.
              Effect.flatMap(({ traceId }) => delivered(traceId, "mcp.session.admitted", 40)),
              Effect.map((admitted) => Number(admitted.tags[flushesAttribute])),
            ),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* Effect.forEach(Array.from({ length: listens }), () =>
                raw("subscriptions/listen", { notifications: { toolsListChanged: true } }),
              );
              for (const { response } of held) expect(response.status).toBe(200);

              // The first listen's request span ended when its stream started. Its event stays
              // open, so only the isolate's on-demand flush exports it, with no other request sent.
              const listen = yield* delivered(held[0]!.traceId, "mcp.session.request", 20);
              expect(listen.tags["executor.mcp.response.held"]).toBe("true");

              const before = yield* counted;
              yield* Effect.sleep(idleMs);
              const after = yield* counted;
              yield* evidence.json("idle-flush.json", {
                listens,
                idleMs,
                flushesBefore: before,
                flushesAfter: after,
              });

              expect(Number.isSafeInteger(before), "Each session request records flushes").toBe(
                true,
              );
              // What may flush the session object isolate between the two counts, each read when
              // its request is admitted:
              // - the timer the first request's own spans arm, if that request lasts over a
              //   second and it fires before the close: 1;
              // - the first request's close: 1;
              // - a timer armed by spans that request ends after its close took the rest, such as
              //   its background work: 1;
              // - each listen's metric exporter, every 30 s from its own start, exports a batch
              //   when its event recorded a measurement, and the batch arms a timer. At most one
              //   tick of each falls in a 12 s window, and ticks a second or more apart arm one
              //   timer each: at most `listens`.
              // A timer the second request's spans arm fires after its admission, so it is not
              // counted. So at most 3 + `listens`. The old loop, one per open event each second,
              // ran 37.
              expect(
                after - before,
                "Idle listen streams cause no telemetry flushes of their own",
              ).toBeLessThanOrEqual(3 + listens);
            }),
          );
        }),
      ),
    { timeout: 120_000 },
  );
});
