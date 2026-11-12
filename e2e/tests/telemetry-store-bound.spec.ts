/**
 * The bundled collector, once its store is full, keeps the traces it holds while an idle server
 * trickles in small exports, instead of evicting the oldest for every export.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/http";
import { randomBytes } from "node:crypto";
import { TestLive, withCase } from "../support/case.ts";
import { serveOtlpCollector } from "../support/otlp-collector.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** A bound a few seconds of exports cross; the shipped bound is 1 GiB. */
const boundMegabytes = 8;
/** An idle server's exports: one small trace each. */
const idleExports = 20;

const Evictions = Schema.Struct({
  evictions: Schema.Struct({ passes: Schema.Number, traces: Schema.Number }),
});

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** One OTLP export of whole traces, `spans` spans each, shaped like the product's database spans. */
const traceExport = (traceIds: ReadonlyArray<string>, spans: number) => {
  const now = BigInt(Date.now()) * 1_000_000n;
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "executor-selfhost")] },
        scopeSpans: [
          {
            scope: { name: "executor" },
            spans: traceIds.flatMap((traceId) => {
              const root = randomBytes(8).toString("hex");
              return Array.from({ length: spans }, (_, index) => ({
                traceId,
                spanId: index === 0 ? root : randomBytes(8).toString("hex"),
                ...(index === 0 ? {} : { parentSpanId: root }),
                name: index === 0 ? "schedule.dispatch" : "sql.execute",
                kind: 1,
                startTimeUnixNano: String(now - 5_000_000n),
                endTimeUnixNano: String(now),
                attributes: [
                  attribute("db.system.name", "sqlite"),
                  attribute(
                    "db.query.text",
                    `select "id", "due_at" from "executor_schedules" where "due_at" <= ? limit ${index}`,
                  ),
                  attribute("executor.record.id", randomBytes(20).toString("hex")),
                ],
                status: { code: 1 },
              }));
            }),
          },
        ],
      },
    ],
  };
};

layer(TestLive, { excludeTestServices: true })("Telemetry store bound", (it) => {
  it.effect(scenarios.telemetryStoreIdleAtBound.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          http = yield* HttpClient.HttpClient;
        const directory = yield* fs.makeTempDirectory({
          directory: target.directory,
          prefix: "collector",
        });
        const collector = yield* serveOtlpCollector(directory, {
          MOTEL_OTEL_MAX_DB_SIZE_MB: String(boundMegabytes),
        });
        const send = (traceIds: ReadonlyArray<string>, spans: number) =>
          Effect.scoped(
            http.post(new URL("/v1/traces", collector).href, {
              body: HttpBody.jsonUnsafe(traceExport(traceIds, spans)),
            }),
          ).pipe(Effect.map(({ status }) => status));
        const stored = (traceId: string) =>
          Effect.scoped(http.get(new URL(`/api/traces/${traceId}`, collector).href)).pipe(
            Effect.map(({ status }) => status === 200),
          );
        const ingestStatus = Effect.scoped(
          http.get(new URL("/api/ingest", collector).href).pipe(Effect.flatMap((r) => r.json)),
        );
        const evictions = (status: unknown) =>
          Schema.decodeUnknownEffect(Evictions)(status).pipe(
            Effect.map(({ evictions }) => evictions),
          );
        const newId = () => randomBytes(16).toString("hex");

        // Fill the store, two 40-span traces an export, until it evicts its first trace.
        const sent: Array<string> = [];
        while (sent.length === 0 || (yield* stored(sent[0]!))) {
          const traceIds = [newId(), newId()];
          expect(yield* send(traceIds, 40)).toBe(200);
          sent.push(...traceIds);
        }
        // Traces are evicted oldest first, so the ones still stored are a suffix of those sent.
        let low = 0;
        let high = sent.length - 1;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (yield* stored(sent[middle]!)) high = middle;
          else low = middle + 1;
        }
        const oldest = sent[low]!;
        const filled = yield* ingestStatus;

        // An idle server's exports, about half a MiB in all, after the store first evicted.
        const idle = Array.from({ length: idleExports }, newId);
        for (const traceId of idle) expect(yield* send([traceId], 10)).toBe(200);

        expect(yield* stored(oldest), "The oldest stored trace is still stored").toBe(true);
        for (const traceId of idle) expect(yield* stored(traceId)).toBe(true);
        // The export that crossed the bound evicted down to the low-water mark in one pass.
        const passes = yield* evictions(filled);
        expect(passes.passes, "Filling the store took one eviction pass").toBe(1);
        expect(
          yield* evictions(yield* ingestStatus),
          "No idle export started an eviction pass",
        ).toEqual(passes);
      }),
    ),
  );
});
