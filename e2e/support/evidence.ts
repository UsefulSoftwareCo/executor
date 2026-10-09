/** Per-test evidence is a scoped service, including errors, exported spans and browser artifacts. */
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { TestContext } from "vitest";
import { createHash } from "node:crypto";
import { EvidenceEntries } from "../report-model.ts";
import { Target } from "./platform.ts";
import { Collector, SpanQuery } from "./contracts.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { axiomSpans } from "./axiom.ts";

/** Public request measurements contain no request bodies, cookies or credentials. */
export interface RequestEvidence {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly traceId: string;
}
/** A traced request as it is sent. A request that never answers is listed with these fields. */
export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly traceId: string;
  readonly spanId: string;
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
    /** Call before sending a traced request, so a request that never answers keeps its trace. */
    readonly sending: (request: SentRequest) => Effect.Effect<void>;
    readonly request: (request: RequestEvidence, span: ClientSpan) => Effect.Effect<void>;
    readonly requests: Effect.Effect<ReadonlyArray<RequestEvidence>>;
    readonly browserTrace: (id: string) => Effect.Effect<void>;
    /**
     * Records a failure the evidence scope's exit does not carry, such as a failure of the case's
     * own cleanup. A failed case keeps the trace of every request it sent.
     */
    readonly failed: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
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
    /** The tags of delivered spans of one operation whose attributes match exactly, in any trace. */
    readonly spans: (
      operation: string,
      attributes: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, string>>>, TelemetryUnavailable>;
    /** Delivered spans of one operation whose attributes match exactly, with their trace and status. */
    readonly search: (
      operation: string,
      attributes: Readonly<Record<string, string>>,
    ) => Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable>;
    /**
     * The delivered log records of one trace, and those whose body contains `text` in any trace,
     * as the collector returns them. Only a collector this suite runs can be read.
     */
    readonly logs: (
      traceId: string,
      text: string,
    ) => Effect.Effect<ReadonlyArray<string>, TelemetryUnavailable>;
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
      const cloud = yield* axiomSpans;
      const origin = fs.readFileString(`${target.directory}/data/diagnostics/collector.json`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))),
        Effect.map((collector) => collector.url),
      );
      const safe = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(() => new TelemetryUnavailable()),
        );
      const search = <A>(
        operation: string,
        attributes: Readonly<Record<string, string>>,
        schema: Schema.Codec<A>,
      ) =>
        target.metadata.target === "cloud" && target.metadata.mode === "attached"
          ? cloud.search(operation, attributes).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              Effect.mapError(() => new TelemetryUnavailable()),
            )
          : safe(
              Effect.scoped(
                Effect.gen(function* () {
                  const url = new URL("/api/spans/search", yield* origin);
                  url.searchParams.set("operation", operation);
                  url.searchParams.set("lookback", "1d");
                  url.searchParams.set("limit", "10000");
                  for (const [key, value] of Object.entries(attributes))
                    url.searchParams.set(`attr.${key}`, value);
                  const response = yield* http.get(url.href);
                  if (response.status !== 200) return yield* new TelemetryUnavailable();
                  return yield* response.json.pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
                  );
                }),
              ),
            );
      return {
        query: (id) =>
          target.metadata.target === "cloud" && target.metadata.mode === "attached"
            ? cloud.trace(id).pipe(Effect.mapError(() => new TelemetryUnavailable()))
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
        spans: (operation, attributes) =>
          search(
            operation,
            attributes,
            Schema.Struct({
              data: Schema.Array(
                Schema.Struct({
                  span: Schema.Struct({ tags: Schema.Record(Schema.String, Schema.String) }),
                }),
              ),
            }),
          ).pipe(Effect.map((found) => found.data.map(({ span }) => span.tags))),
        search: (operation, attributes) => search(operation, attributes, SpanQuery),
        logs: (traceId, text) =>
          target.metadata.target === "cloud" && target.metadata.mode === "attached"
            ? Effect.fail(new TelemetryUnavailable())
            : safe(
                Effect.scoped(
                  Effect.gen(function* () {
                    const base = yield* origin;
                    const byBody = new URL("/api/logs/search", base);
                    byBody.searchParams.set("body", text);
                    byBody.searchParams.set("lookback", "1d");
                    const read = (url: URL) =>
                      Effect.gen(function* () {
                        const response = yield* http.get(url.href);
                        if (response.status !== 200) return yield* new TelemetryUnavailable();
                        return yield* response.text;
                      });
                    return [
                      yield* read(new URL(`/api/traces/${traceId}/logs`, base)),
                      yield* read(byBody),
                    ];
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

/** Traces kept for every case: the slowest API requests and the latest browser traces. */
const slowestTraceCount = 5;
/**
 * A failed case keeps the trace of every request it sent, up to this many bytes of compact JSON.
 * The largest case, the 1,000-account inventory load, sends about 4,000 requests whose traces
 * take 47 MB. Past the budget, the oldest traces are left out. A case can set its own budget.
 */
export const FailureTraceBudget = Context.Reference<number>("e2e/FailureTraceBudget", {
  defaultValue: () => 64 * 1024 * 1024,
});
/** How long a failed case waits for the server to deliver the spans that answered its requests. */
const failureDeliveryWait = 5_000;
/** How many traces a failed case reads from the collector at a time. */
const failureQueryBatch = 32;
/**
 * How long a case's evidence may spend exporting and reading traces. The cleanup hook allows 60
 * seconds (30 for the welcome email), and the product still has to stop after the evidence is
 * written. Traces not read by then are listed as unfetched.
 */
const traceCollectionTime = 25_000;

/** A traced request the case sent, answered or not. */
interface Sent extends SentRequest {
  readonly answered: boolean;
}
/** One trace to read into telemetry.json, and why it is kept. */
interface Planned {
  readonly traceId: string;
  readonly spanId: string | undefined;
  readonly kept: ReadonlyArray<string>;
  /** Kept even past the budget. */
  readonly always: boolean;
}

/** Build a fresh evidence store for a single Vitest case. Its scope writes the final outcome. */
export const evidenceLayer = (context: TestContext) =>
  scenarioEvidence({ file: context.task.file.name, name: context.task.name });

/** Record the same evidence for an interactive scenario or a committed Vitest case. */
export const scenarioEvidence = (identity: { readonly file: string; readonly name: string }) =>
  Layer.effect(
    Evidence,
    Effect.gen(function* () {
      const target = yield* Target;
      const telemetry = yield* Telemetry;
      const recording = yield* RecordingFocus;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const budget = yield* FailureTraceBudget;
      const id = createHash("sha256")
        .update(`${target.metadata.target}:${identity.file}:${identity.name}`)
        .digest("hex")
        .slice(0, 16);
      const directory = path.join(
        target.evidenceDirectory ?? target.directory,
        "report/evidence",
        id,
      );
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const started = yield* Clock.currentTimeMillis;
      const attachments: (typeof EvidenceEntries.Type)[number]["attachments"][number][] = [];
      const annotations: { type: string; description: string }[] = [];
      const steps: { name: string; durationMs: number; status: string }[] = [];
      const requests = yield* Ref.make<ReadonlyArray<RequestEvidence>>([]);
      const spans = yield* Ref.make<ReadonlyArray<ClientSpan>>([]);
      const browserTraces = new Set<string>();
      // Every request the case sent, in the order each was last sent or answered, oldest first.
      const sent = new Map<string, Sent>();
      let newestSent: string | undefined;
      // A failure the evidence scope's exit does not carry, such as the case's own cleanup failing.
      let failure: Cause.Cause<unknown> | undefined;
      const artifact = (name: string, contentType: string, file: string) =>
        Effect.sync(() => {
          // A file written again, such as by a flush and the final write, is listed once.
          if (!attachments.some((attachment) => attachment.name === name))
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
      yield* json("scenario.json", {
        id: target.scenarioId,
        label: target.scenarioLabel,
        origin: target.metadata.origin,
        directory: target.directory,
      });
      const report = (cause: Cause.Cause<unknown> | undefined) =>
        Effect.gen(function* () {
          const ended = yield* Clock.currentTimeMillis;
          yield* fs.writeFileString(
            path.join(directory, "result.json"),
            JSON.stringify(
              {
                id,
                title: identity.name,
                file: path.basename(identity.file),
                target: target.metadata.target,
                origin: target.metadata.origin,
                status: cause === undefined ? "passed" : "failed",
                duration: ended - started,
                errors: cause === undefined ? [] : [Cause.pretty(cause)],
                annotations,
                attachments,
              },
              null,
              2,
            ),
          );
        }).pipe(Effect.orDie);
      // The final write reports the outcome before it reads any trace, and again when it ends, so a
      // cleanup hook that runs out of time still leaves result.json and trace-ids.json.
      const write = (cause: Cause.Cause<unknown> | undefined, final: boolean) =>
        Effect.gen(function* () {
          const failed = cause !== undefined;
          const collectUntil = (yield* Clock.currentTimeMillis) + traceCollectionTime;
          const outcome = final ? report(cause) : Effect.void;
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
          const unanswered = [...sent.values()].filter(({ answered }) => !answered);
          yield* json(
            "unanswered-requests.json",
            unanswered.map(({ method, path, traceId }) => ({ method, path, traceId })),
          );
          const slowest = new Set(
            rows
              .toSorted((a, b) => b.durationMs - a.durationMs)
              .slice(0, slowestTraceCount)
              .map((r) => r.traceId),
          );
          const browser = [...browserTraces].slice(-slowestTraceCount);
          if (target.metadata.target === "cloud" && target.metadata.mode === "attached") {
            yield* json("trace-ids.json", {
              api: rows.map((r) => r.traceId),
              browser: [...browserTraces],
              failure: [],
              dropped: [],
              unfetched: [],
            });
            yield* json("telemetry.json", {
              state: "not-collected",
              reason: "Cloud telemetry exports to Axiom; collection is a separate adapter.",
            });
            return yield* outcome;
          }
          // A failed case keeps every request's trace, newest first. Its newest request, the
          // requests still unanswered and the traces a passing case keeps are always kept; the
          // others are kept while they fit the budget, and the oldest are left out past it.
          const newestFirst = [...sent.values()].toReversed();
          const reasons = (traceId: string) => [
            ...(failed ? ["failure"] : []),
            ...(slowest.has(traceId) ? ["slowest"] : []),
          ];
          const failures: ReadonlyArray<Planned> = failed
            ? newestFirst.map((request) => ({
                traceId: request.traceId,
                spanId: request.spanId,
                kept: reasons(request.traceId),
                always:
                  !request.answered ||
                  request.traceId === newestSent ||
                  slowest.has(request.traceId),
              }))
            : [];
          const extras = new Map<string, string[]>();
          // A failed case already reads its slowest requests with the others.
          if (!failed) for (const traceId of slowest) extras.set(traceId, ["slowest"]);
          for (const traceId of browser)
            extras.set(traceId, [...(extras.get(traceId) ?? []), "browser"]);
          // Read order: the newest request first, then the other traces always kept, then the rest
          // newest first, so a deadline leaves out the oldest.
          const alwaysKept = failures
            .filter(({ always }) => always)
            .toSorted(
              (a, b) => Number(b.traceId === newestSent) - Number(a.traceId === newestSent),
            );
          const budgeted = failures.filter(({ always }) => !always);
          const others = [...extras].map(([traceId, kept]): Planned => ({
            traceId,
            spanId: undefined,
            kept,
            always: true,
          }));
          const plan = [...alwaysKept, ...budgeted, ...others];
          const keptIds = new Set<string>();
          let overflowAt: number | undefined;
          const listed = (state: string) => {
            const dropped =
              overflowAt === undefined
                ? []
                : budgeted.slice(overflowAt).filter(({ traceId }) => !keptIds.has(traceId));
            const droppedIds = new Set(dropped.map(({ traceId }) => traceId));
            const unfetched = plan.filter(
              ({ traceId }) => !keptIds.has(traceId) && !droppedIds.has(traceId),
            );
            return {
              unfetched,
              ids: json("trace-ids.json", {
                state,
                api: rows.map((r) => r.traceId),
                browser: [...browserTraces],
                failure: failures.map(({ traceId }) => traceId).filter((id) => keptIds.has(id)),
                dropped: dropped.map(({ traceId }) => traceId),
                // Traces not read yet while collecting, and not read before the deadline after.
                unfetched: unfetched.map(({ traceId }) => traceId),
                requests: newestFirst.map(({ method, path, traceId, answered }) => ({
                  traceId,
                  method,
                  path,
                  answered,
                  kept: reasons(traceId),
                })),
              }),
            };
          };
          yield* artifact("client-export.json", "application/json", "client-export.json");
          yield* artifact("telemetry.json", "application/json", "telemetry.json");
          yield* listed("collecting").ids;
          yield* outcome;

          const exported = yield* telemetry.export(yield* Ref.get(spans)).pipe(Effect.result);
          yield* json("client-export.json", exported);
          // telemetry.json grows a batch at a time, so the traces read so far survive a cleanup
          // hook that runs out of time.
          const file = path.join(directory, "telemetry.json");
          let entries = 0;
          const append = (values: ReadonlyArray<unknown>) =>
            fs
              .writeFileString(
                file,
                values
                  .map((value) => `${entries++ === 0 ? "\n" : ",\n"}${JSON.stringify(value)}`)
                  .join(""),
                { flag: "a", mode: 0o600 },
              )
              .pipe(Effect.orDie);
          yield* fs.writeFileString(file, "[", { mode: 0o600 }).pipe(Effect.orDie);
          const entry = (
            traceId: string,
            kept: ReadonlyArray<string>,
            query: typeof telemetry.query,
          ) =>
            query(traceId).pipe(
              Effect.map((value) => ({ id: traceId, kept, ...value })),
              Effect.catch(() =>
                Effect.succeed({ id: traceId, kept, error: "Motel query failed" }),
              ),
            );
          // The server exports its spans every second, so the requests just before the failure
          // are not delivered yet. Each read waits a bounded time for the server span that
          // answered the test's client span.
          const deadline = (yield* Clock.currentTimeMillis) + failureDeliveryWait;
          const delivered = (
            traceId: string,
            spanId: string,
          ): Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable> =>
            telemetry.query(traceId).pipe(
              Effect.flatMap((found) =>
                Effect.gen(function* () {
                  if (
                    found.data.some(({ span }) => span.parentSpanId === spanId) ||
                    (yield* Clock.currentTimeMillis) >= deadline
                  )
                    return found;
                  yield* Effect.sleep("250 millis");
                  return yield* delivered(traceId, spanId);
                }),
              ),
            );
          const read = ({ traceId, spanId, kept }: Planned) =>
            spanId === undefined
              ? entry(traceId, kept, telemetry.query)
              : entry(traceId, kept, (id) => delivered(id, spanId));
          const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
          let used = 0;
          // The batch being read. Settling it is atomic, so the deadline either stops a batch
          // before it settles, keeping the traces it read, or after.
          let pending: { readonly index: number; value?: unknown }[] = [];
          const settle = Effect.gen(function* () {
            const values: unknown[] = [];
            for (const { index, value } of pending) {
              if (value === undefined) continue;
              const trace = plan[index]!;
              used += size(value);
              if (!trace.always) {
                if (overflowAt !== undefined) continue;
                if (used > budget) {
                  overflowAt = index - alwaysKept.length;
                  continue;
                }
              }
              keptIds.add(trace.traceId);
              values.push(value);
            }
            pending = [];
            if (values.length > 0) yield* append(values);
          }).pipe(Effect.uninterruptible);
          const readAll = (from: number, to: number) =>
            Effect.gen(function* () {
              for (let next = from; next < to; next += failureQueryBatch) {
                if (!plan[next]!.always && overflowAt !== undefined) return;
                pending = Array.from(
                  { length: Math.min(failureQueryBatch, to - next) },
                  (_, offset) => ({ index: next + offset }),
                );
                yield* Effect.forEach(
                  pending,
                  (slot) =>
                    read(plan[slot.index]!).pipe(
                      Effect.map((value) => {
                        slot.value = value;
                      }),
                    ),
                  { concurrency: "unbounded", discard: true },
                );
                yield* settle;
              }
            });
          const boundaries = [
            0,
            alwaysKept.length,
            alwaysKept.length + budgeted.length,
            plan.length,
          ];
          const finished = yield* Effect.forEach(
            [0, 1, 2],
            (group) => readAll(boundaries[group]!, boundaries[group + 1]!),
            { discard: true },
          ).pipe(
            Effect.interruptible,
            Effect.timeoutOption(Math.max(0, collectUntil - (yield* Clock.currentTimeMillis))),
          );
          // The batch the deadline stopped keeps the traces it had read.
          yield* settle;
          const { unfetched, ids } = listed(Option.isSome(finished) ? "complete" : "partial");
          yield* append(
            unfetched.map(({ traceId, kept }) => ({
              id: traceId,
              kept,
              error: "Not read before the evidence deadline",
            })),
          );
          yield* fs.writeFileString(file, "\n]\n", { flag: "a" }).pipe(Effect.orDie);
          yield* ids;
          yield* outcome;
        });
      yield* Effect.addFinalizer((exit) =>
        // withCase records a failure of the case's own cleanup, which closes before this scope.
        write(
          Exit.isFailure(exit)
            ? failure === undefined
              ? exit.cause
              : Cause.combine(exit.cause, failure)
            : failure,
          true,
        ),
      );
      return Evidence.of({
        directory,
        attach,
        json,
        artifact,
        flush: Effect.suspend(() => write(failure, false)),
        failed: (cause) =>
          Effect.sync(() => {
            failure = failure === undefined ? cause : Cause.combine(failure, cause);
          }),
        sending: (request) =>
          Effect.sync(() => {
            sent.delete(request.traceId);
            sent.set(request.traceId, { ...request, answered: false });
            newestSent = request.traceId;
          }),
        request: (row, span) =>
          Effect.gen(function* () {
            // An answer makes the request newest again.
            sent.delete(row.traceId);
            sent.set(row.traceId, {
              method: row.method,
              path: row.path,
              traceId: row.traceId,
              spanId: span.spanId,
              answered: true,
            });
            yield* Ref.update(requests, (rows) => [...rows, row]);
            yield* Ref.update(spans, (all) => [...all, span]);
          }),
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
