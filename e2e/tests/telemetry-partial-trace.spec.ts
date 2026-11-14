/**
 * A trace the collector answers in part, because ordering it would take more than the collector's
 * skeleton ceiling (its README, "Readers"), is never read by a check as the whole trace: the
 * suite's `Telemetry.query` fails, without retrying, while `Telemetry.stored`, which failure
 * evidence reads, keeps the spans returned and the collector's marker beside them.
 */
import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";
import { HttpBody, HttpClient } from "effect/http";
import { randomBytes } from "node:crypto";
import { TestLive, withCase } from "../support/case.ts";
import { Telemetry } from "../support/evidence.ts";
import { ownCollectorSpans, serveOtlpCollector } from "../support/otlp-collector.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/**
 * Spans that each name a parent that never arrives. The collector counts 640 bytes of skeleton for
 * such a span against a 48 MiB ceiling, so it answers at most 78,643 of them (README, "Readers").
 */
const spans = 80_000;
const perExport = 10_000;

layer(TestLive, { excludeTestServices: true })("Telemetry partial trace", (it) => {
  it.effect(scenarios.telemetryPartialTrace.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          fs = yield* FileSystem.FileSystem,
          http = yield* HttpClient.HttpClient;
        // A collector of the scenario's own, so no other scenario's reads meet this trace.
        const directory = yield* fs.makeTempDirectory({
          directory: target.directory,
          prefix: "partial",
        });
        const collector = yield* serveOtlpCollector(directory);
        const traceId = randomBytes(16).toString("hex");
        const start = BigInt(Date.now()) * 1_000_000n;
        for (let first = 0; first < spans; first += perExport) {
          const batch = Array.from({ length: perExport }, (_, offset) => {
            const index = BigInt(first + offset);
            return {
              traceId,
              spanId: randomBytes(8).toString("hex"),
              parentSpanId: randomBytes(8).toString("hex"),
              name: "orphan",
              kind: 1,
              startTimeUnixNano: String(start + index),
              endTimeUnixNano: String(start + index + 1n),
            };
          });
          const { status } = yield* Effect.scoped(
            http.post(new URL("/v1/traces", collector).href, {
              body: HttpBody.jsonUnsafe({
                resourceSpans: [
                  {
                    resource: {
                      attributes: [{ key: "service.name", value: { stringValue: "partial" } }],
                    },
                    scopeSpans: [{ scope: { name: "e2e.partial" }, spans: batch }],
                  },
                ],
              }),
            }),
          );
          expect(status).toBe(200);
        }
        // The suite's own reader, pointed at this collector (`collector.json` in its directory).
        const reader = Telemetry.layer.pipe(
          Layer.provide(Layer.succeed(Target, { ...target, directory })),
        );
        const { query, stored, searchWholeEnvironment, logs, logsWholeEnvironment } =
          yield* Effect.gen(function* () {
            return yield* Telemetry;
          }).pipe(Effect.provide(reader));

        const kept = yield* stored(traceId);
        expect(kept.meta?.truncated, "the collector marks the answer as part of the trace").toBe(
          true,
        );
        expect(kept.meta?.spanCount).toBe(spans);
        expect(kept.meta?.returned).toBeLessThan(spans);
        // Each returned span comes with a placeholder for its missing parent.
        expect(kept.data.length).toBe(2 * kept.meta!.returned!);

        const read = yield* Effect.exit(query(traceId));
        expect(Exit.isFailure(read), "a check cannot read the trace as whole").toBe(true);
        if (Exit.isFailure(read)) {
          expect(Cause.hasDies(read.cause), "the read is a defect, never retried").toBe(true);
          expect(Cause.pretty(read.cause)).toContain(
            `The collector answered trace ${traceId} in part (${kept.meta!.returned} of ${spans} spans)`,
          );
        }

        // A span search the collector cut off at its limit fails the same way: 80,000 spans match.
        const searched = yield* Effect.exit(searchWholeEnvironment("orphan", {}));
        expect(Exit.isFailure(searched), "a check cannot read a cut-off search as all").toBe(true);
        if (Exit.isFailure(searched)) {
          expect(Cause.hasDies(searched.cause)).toBe(true);
          expect(Cause.pretty(searched.cause)).toContain("answered only those");
        }
        const windowed = yield* Effect.exit(
          ownCollectorSpans(collector, {
            from: Date.now() - 60_000,
            to: Date.now(),
            operation: "orphan",
          }),
        );
        expect(Exit.isFailure(windowed), "nor a cut-off search in a time window").toBe(true);
        if (Exit.isFailure(windowed)) expect(Cause.hasDies(windowed.cause)).toBe(true);

        // Log lists are read whole: 601 logs of one trace, more than one page, the oldest holding a
        // marker a privacy check looks for. Both log readers must see it.
        const logTrace = randomBytes(16).toString("hex");
        const common = `partial-logs-${randomBytes(4).toString("hex")}`;
        const forbidden = `forbidden-${randomBytes(4).toString("hex")}`;
        const records = Array.from({ length: 601 }, (_, index) => ({
          timeUnixNano: String(start + BigInt(index) * 1_000_000n),
          severityNumber: 9,
          severityText: "INFO",
          body: { stringValue: index === 0 ? `${common} ${forbidden}` : `${common} ${index}` },
          traceId: logTrace,
        }));
        const { status: logged } = yield* Effect.scoped(
          http.post(new URL("/v1/logs", collector).href, {
            body: HttpBody.jsonUnsafe({
              resourceLogs: [
                {
                  resource: {
                    attributes: [{ key: "service.name", value: { stringValue: "partial" } }],
                  },
                  scopeLogs: [{ scope: { name: "e2e.partial" }, logRecords: records }],
                },
              ],
            }),
          }),
        );
        expect(logged).toBe(200);
        const traceLogs = yield* logs(logTrace);
        expect(traceLogs, "a trace's logs are read past the first page").toContain(forbidden);
        expect(traceLogs.split(`"${common} `).length - 1).toBe(601);
        const found = yield* logsWholeEnvironment(common);
        expect(found, "a log search is read past the first page").toContain(forbidden);
      }),
    ),
  );
});
