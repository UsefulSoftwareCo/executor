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

const listens = 3;
const idleMs = 12_000;
const revision = "2026-07-28";
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const flushesAttribute = "executor.telemetry.isolate.flushes";

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
        return { traceId, response };
      }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return { raw };
  });

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
          const counted = Effect.scoped(
            raw("tools/list", {}).pipe(
              Effect.tap(({ response }) => response.text),
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
