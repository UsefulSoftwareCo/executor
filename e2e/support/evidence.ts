/** Per-test evidence is a scoped service, including errors, exported spans and browser artifacts. */
import { Cause, Clock, Context, Effect, Exit, FileSystem, Layer, Path, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { TestContext } from "vitest";
import { createHash } from "node:crypto";
import { EvidenceEntries } from "../report-model.ts";
import { Target } from "./platform.ts";
import { Collector, SpanQuery } from "./contracts.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { axiomTraceQuery } from "./axiom.ts";

/** Public request measurements contain no request bodies, cookies or credentials. */
export interface RequestEvidence {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly traceId: string;
}
/** One ended test-client span, sent through OTLP to complete the distributed trace. */
export interface ClientSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number };
}
/** The case owns artifact paths and records every named step through a typed Effect operation. */
export class Evidence extends Context.Service<
  Evidence,
  {
    readonly directory: string;
    readonly attach: (
      name: string,
      contentType: string,
      contents: string | Uint8Array,
    ) => Effect.Effect<void>;
    readonly json: (name: string, contents: unknown) => Effect.Effect<void>;
    readonly artifact: (name: string, contentType: string, file: string) => Effect.Effect<void>;
    readonly request: (request: RequestEvidence, span: ClientSpan) => Effect.Effect<void>;
    readonly requests: Effect.Effect<ReadonlyArray<RequestEvidence>>;
    readonly browserTrace: (id: string) => Effect.Effect<void>;
    readonly intervention: (name: string) => Effect.Effect<void>;
    readonly step: <A, E, R>(
      name: string,
      program: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly flush: Effect.Effect<void>;
  }
>()("e2e/Evidence") {}

/** Motel queries read delivered spans through HTTP. No in-process instrumentation assertions. */
export class Telemetry extends Context.Service<
  Telemetry,
  {
    readonly query: (traceId: string) => Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable>;
    readonly export: (
      spans: ReadonlyArray<ClientSpan>,
    ) => Effect.Effect<number, TelemetryUnavailable>;
  }
>()("e2e/Telemetry") {
  static readonly layer = Layer.effect(
    Telemetry,
    Effect.gen(function* () {
      const target = yield* Target;
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const cloudQuery = yield* axiomTraceQuery;
      const origin = fs.readFileString(`${target.directory}/data/diagnostics/collector.json`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))),
        Effect.map((collector) => collector.url),
      );
      const safe = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(() => new TelemetryUnavailable()),
        );
      return {
        query: (id) =>
          target.metadata.target === "cloud" && target.metadata.mode === "attached"
            ? cloudQuery(id).pipe(Effect.mapError(() => new TelemetryUnavailable()))
            : safe(
                Effect.scoped(
                  Effect.gen(function* () {
                    const url = yield* origin;
                    const response = yield* http.get(`${url}/api/traces/${id}/spans`);
                    if (response.status !== 200) return yield* new TelemetryUnavailable();
                    return yield* response.json.pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(SpanQuery)),
                    );
                  }),
                ),
              ),
        export: (spans) =>
          safe(
            Effect.scoped(
              Effect.gen(function* () {
                const url = yield* origin;
                const response = yield* http.execute(
                  HttpClientRequest.post(`${url}/v1/traces`).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      resourceSpans: [
                        {
                          resource: {
                            attributes: [
                              { key: "service.name", value: { stringValue: "executor-e2e" } },
                            ],
                          },
                          scopeSpans: [{ scope: { name: "e2e.http" }, spans }],
                        },
                      ],
                    }),
                  ),
                );
                yield* response.text;
                return response.status;
              }),
            ),
          ),
      };
    }),
  );
}
/** Collector failures are explicit and safe to retain in reports. */
export class TelemetryUnavailable extends Schema.TaggedError<TelemetryUnavailable>()(
  "TelemetryUnavailable",
  {},
) {}

/** Build a fresh evidence store for a single Vitest case. Its scope writes the final outcome. */
export const evidenceLayer = (context: TestContext) =>
  Layer.effect(
    Evidence,
    Effect.gen(function* () {
      const target = yield* Target;
      const telemetry = yield* Telemetry;
      const recording = yield* RecordingFocus;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const id = createHash("sha256")
        .update(`${target.metadata.target}:${context.task.file.name}:${context.task.name}`)
        .digest("hex")
        .slice(0, 16);
      const directory = path.join(target.directory, "report/evidence", id);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const started = yield* Clock.currentTimeMillis;
      const attachments: (typeof EvidenceEntries.Type)[number]["attachments"][number][] = [];
      const annotations: { type: string; description: string }[] = [];
      const steps: { name: string; durationMs: number; status: string }[] = [];
      const requests = yield* Ref.make<ReadonlyArray<RequestEvidence>>([]);
      const spans = yield* Ref.make<ReadonlyArray<ClientSpan>>([]);
      const browserTraces = new Set<string>();
      const artifact = (name: string, contentType: string, file: string) =>
        Effect.sync(() => {
          attachments.push({ name, contentType, href: `evidence/${id}/${file}` });
        });
      const attach = (name: string, contentType: string, contents: string | Uint8Array) =>
        Effect.gen(function* () {
          if (path.basename(name) !== name)
            return yield* Effect.die(new Error("Artifact names must be basenames"));
          if (typeof contents === "string")
            yield* fs.writeFileString(path.join(directory, name), contents, { mode: 0o600 });
          else yield* fs.writeFile(path.join(directory, name), contents, { mode: 0o600 });
          yield* artifact(name, contentType, name);
        }).pipe(Effect.orDie);
      const json = (name: string, contents: unknown) =>
        attach(name, "application/json", JSON.stringify(contents, null, 2));
      const flush = Effect.gen(function* () {
        const rows = yield* Ref.get(requests);
        yield* json("requests.json", rows);
        yield* json("steps.json", steps);
        const timeline = yield* recording.snapshot;
        yield* json("recording-timeline.json", timeline);
        if (timeline.windows.length > 0)
          yield* json("recording-pacing.json", {
            browserActionDelayMs: target.recordingPaceMs,
            readingPauseMs: target.recordingPaceMs * 2,
            includedInTestDuration: true,
          });
        const durations = rows.map((request) => request.durationMs).sort((a, b) => a - b);
        yield* json("performance.json", {
          count: rows.length,
          p50Ms: durations[Math.floor(durations.length * 0.5)] ?? null,
          p95Ms: durations[Math.floor(durations.length * 0.95)] ?? null,
          maxMs: durations.at(-1) ?? null,
          unattended: annotations.length === 0,
        });
        yield* json("trace-ids.json", {
          api: rows.map((r) => r.traceId),
          browser: [...browserTraces],
        });
        if (target.metadata.target === "cloud" && target.metadata.mode === "attached") {
          yield* json("telemetry.json", {
            state: "not-collected",
            reason: "Cloud telemetry exports to Axiom; collection is a separate adapter.",
          });
          return;
        }
        const exported = yield* telemetry.export(yield* Ref.get(spans)).pipe(Effect.result);
        yield* json("client-export.json", exported);
        const ids = [
          ...new Set([
            ...rows
              .toSorted((a, b) => b.durationMs - a.durationMs)
              .slice(0, 5)
              .map((r) => r.traceId),
            ...[...browserTraces].slice(-5),
          ]),
        ];
        yield* json(
          "telemetry.json",
          yield* Effect.forEach(
            ids,
            (id) =>
              telemetry.query(id).pipe(
                Effect.map((value) => ({ id, ...value })),
                Effect.catch(() => Effect.succeed({ id, error: "Motel query failed" })),
              ),
            { concurrency: 4 },
          ),
        );
      });
      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          yield* flush;
          const ended = yield* Clock.currentTimeMillis;
          yield* fs.writeFileString(
            path.join(directory, "result.json"),
            JSON.stringify(
              {
                id,
                title: context.task.name,
                file: path.basename(context.task.file.name),
                target: target.metadata.target,
                status: Exit.isSuccess(exit) ? "passed" : "failed",
                duration: ended - started,
                errors: Exit.isFailure(exit) ? [Cause.pretty(exit.cause)] : [],
                annotations,
                attachments,
              },
              null,
              2,
            ),
          );
        }).pipe(Effect.orDie),
      );
      return Evidence.of({
        directory,
        attach,
        json,
        artifact,
        flush,
        request: (row, span) =>
          Ref.update(requests, (rows) => [...rows, row]).pipe(
            Effect.andThen(Ref.update(spans, (all) => [...all, span])),
          ),
        requests: Ref.get(requests),
        browserTrace: (id) =>
          Effect.sync(() => {
            browserTraces.add(id);
          }),
        intervention: (name) =>
          Effect.sync(() => {
            annotations.push({ type: "manual intervention", description: name });
          }),
        step: <A, E, R>(name: string, program: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            return yield* program.pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  const end = yield* Clock.currentTimeMillis;
                  steps.push({
                    name,
                    durationMs: end - start,
                    status: Exit.isSuccess(exit) ? "passed" : "failed",
                  });
                }),
              ),
              Effect.withSpan(name),
            );
          }),
      });
    }),
  );
