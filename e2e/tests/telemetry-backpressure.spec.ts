/** Browser and app crash reports survive a collector that sheds load, within the relay's budget. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Layer, Schedule, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Api, body, SessionClients } from "../support/api.ts";
import { provisionSelfHostActors } from "../support/actors.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile } from "../support/profiles.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { type Refusal, throttlingCollector } from "../support/throttling-collector.ts";
import { scenarios } from "../test-plan.ts";

/** Node timers may fire up to a millisecond early; both clocks are this machine's. */
const early = 5;
/** More app calls than the relay could once hold while an export waited. */
const burstCalls = 40;

layer(TestLive, { excludeTestServices: true })("Telemetry backpressure", (it) => {
  it.effect(scenarios.telemetryBackpressure.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const collector = yield* throttlingCollector;
        const origin = yield* startFreshSelfHost(target, {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const visitor = yield* api.session();
        // Each report is its own trace; the proxy refuses the exports that carry its ID.
        const report = (refusals: ReadonlyArray<Refusal>) =>
          Effect.gen(function* () {
            const traceId = randomBytes(16).toString("hex");
            yield* collector.refuse(traceId, refusals);
            const now = BigInt(yield* Clock.currentTimeMillis) * 1_000_000n;
            const response = yield* api.request(visitor, "POST", "/api/telemetry/traces", {
              resourceSpans: [
                {
                  scopeSpans: [
                    {
                      spans: [
                        {
                          traceId,
                          spanId: randomBytes(8).toString("hex"),
                          name: "ui.backpressure.report",
                          kind: 1,
                          startTimeUnixNano: String(now),
                          endTimeUnixNano: String(now + 1_000_000n),
                          status: { code: 0 },
                        },
                      ],
                    },
                  ],
                },
              ],
            });
            return {
              traceId,
              status: response.status,
              arrivals: yield* collector.arrivals(traceId),
            };
          });
        const stored = (traceId: string) =>
          collector.query(traceId).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName === "ui.backpressure.report")
                ? Effect.void
                : Effect.fail(new Error("The accepted report is not in the collector")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 25 }),
          );

        // Motel's answer when its ingest queue is full.
        const full = yield* report([{ status: 429, retryAfter: () => "1" }]);
        expect(full.status, "a report the full queue refused is sent again").toBe(202);
        expect(full.arrivals.map(({ status }) => status)).toEqual([429, 200]);
        expect(full.arrivals[1]!.at - full.arrivals[0]!.at).toBeGreaterThanOrEqual(1_000 - early);
        yield* stored(full.traceId);

        // RFC 9110 also allows an HTTP date; it names a whole second one to two seconds away.
        let until = 0;
        const dated = yield* report([
          {
            status: 429,
            retryAfter: (now) => {
              until = Math.floor(now / 1_000) * 1_000 + 2_000;
              return new Date(until).toUTCString();
            },
          },
        ]);
        expect(dated.status, "a dated Retry-After inside the budget is honored").toBe(202);
        expect(dated.arrivals.map(({ status }) => status)).toEqual([429, 200]);
        expect(dated.arrivals[1]!.at, "not sent again before the date").toBeGreaterThanOrEqual(
          until - early,
        );
        yield* stored(dated.traceId);

        // OTLP throttles with 503 too, as Motel does while its storage is unavailable.
        const unavailable = yield* report([{ status: 503, retryAfter: () => "2" }]);
        expect(unavailable.status, "a throttled 503 is sent again after its delay").toBe(202);
        expect(unavailable.arrivals.map(({ status }) => status)).toEqual([503, 200]);
        expect(
          unavailable.arrivals[1]!.at - unavailable.arrivals[0]!.at,
          "not sent again before the delay",
        ).toBeGreaterThanOrEqual(2_000 - early);
        yield* stored(unavailable.traceId);

        // A delay past the budget ends the attempt instead of sending early.
        const later = yield* report([{ status: 503, retryAfter: () => "10" }]);
        expect(later.status, "the relay stops at its three-second budget").toBe(504);
        expect(
          later.arrivals.map(({ status }) => status),
          "never sent again before the collector's delay",
        ).toEqual([503]);

        // A rejected export is not throttling and is never resent.
        const rejected = yield* report([{ status: 400 }]);
        expect(rejected.status).toBe(502);
        expect(rejected.arrivals.map(({ status }) => status)).toEqual([400]);
      }),
    ),
  );

  it.effect(scenarios.appTelemetryBurst.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const collector = yield* throttlingCollector;
        const origin = yield* startFreshSelfHost(target, {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
        });
        const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provide(Layer.fresh(Api.layer)),
            Effect.provide(Layer.fresh(SessionClients.layer)),
            Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
          );
        const api = yield* scoped(Api);
        const actors = yield* scoped(provisionSelfHostActors);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Telemetry burst",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({ ping: query({ input: object({}) }, async () => true) }),
});`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), deployed);
        const path = `${prefix}/apps/${app.id}`;
        const profile = yield* scoped(createProfile(actors.owner, path));
        const call = api
          .request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "ping",
            input: {},
          })
          .pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
          );
        // Each call is its own trace. Wait until setup's app telemetry has arrived, then count
        // only the traces the burst adds.
        yield* call;
        const before = yield* collector.appTraces(app.id).pipe(
          Effect.filterOrFail(
            (traces) => traces.size > 0,
            () => new Error("No app telemetry reached the collector"),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
        );

        // The collector sheds the next export of this app's telemetry for two seconds, which
        // holds the relay's export while a burst of calls finishes behind it.
        yield* collector.refuse(app.id, [{ status: 503, retryAfter: () => "2" }]);
        yield* Effect.forEach(Array.from({ length: burstCalls }), () => call, {
          concurrency: burstCalls,
          discard: true,
        });
        const added = yield* collector.appTraces(app.id).pipe(
          Effect.map((traces) => [...traces].filter((trace) => !before.has(trace)).length),
          Effect.repeat({
            until: (count) => count >= burstCalls,
            schedule: Schedule.spaced("250 millis"),
            times: 60,
          }),
        );
        expect(added, "every call's app telemetry reached the collector").toBeGreaterThanOrEqual(
          burstCalls,
        );
        const held = yield* collector.arrivals(app.id);
        expect(held[0]?.status, "the collector shed the first export").toBe(503);
      }),
    ),
  );
});
