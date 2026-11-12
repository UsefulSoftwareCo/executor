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
  Schedule,
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
import { scopeOf, type Scope } from "./scope.ts";

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

/**
 * The IDs a scenario creates that delivered spans record. On Cloud every scenario of a job shares
 * one collector, so a span read names what the scenario owns: one of these IDs, or its own traces.
 * A filter on anything else, such as a path, a job name or a status, also matches other
 * scenarios' spans, so it can narrow a scope but never be one.
 */
const ownedIds = {
  organization: "executor.organization.id",
  app: "executor.app.id",
  account: "executor.account.id",
  run: "executor.run.id",
  user: "executor.user.id",
  /** The browser page a scenario's own page reported (`executor.page.id`). */
  page: "executor.page.id",
  /** A deploy's build (`bld_<uuid>`), and the Worker that runs it for one set of accounts. */
  build: "executor.build.id",
  worker: "executor.worker.identity",
  /** A Tail record names the trace of the request it records. */
  requestTrace: "executor.trace_id",
  /** A v1 import names the v1 workspace it imports. */
  v1Workspace: "executor.v1_import.organization",
} as const;
type OwnedId = keyof typeof ownedIds;
/**
 * Which delivered spans a read returns, by one kind: those of the scenario's own traces, those
 * recording an ID it created, or those of a dashboard path under its own organization
 * (`/org/<slug>/…`). A scope naming two kinds does not typecheck, and one with a missing or empty
 * ID, or no traces, is a defect.
 */
export type SpanScope = Scope<
  { readonly traces: ReadonlyArray<string>; readonly organizationPath: string } & {
    readonly [K in OwnedId]: string;
  }
>;
/** One delivered span. */
export type DeliveredSpan = (typeof SpanQuery.Type)["data"][number]["span"];

/** Motel queries read delivered spans through HTTP. No in-process instrumentation assertions. */
export class Telemetry extends Context.Service<
  Telemetry,
  {
    readonly query: (traceId: string) => Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable>;
    /**
     * The spans of the scenario's own traces once `ready` holds for them. A Cloud isolate exports
     * the spans that have ended with whichever request flushes next, so a trace arrives in pieces:
     * read one only through this, with `ready` naming every span the check reads. It fails with
     * its last attempt's error: `TraceUnsettled` when the spans arrived but `ready` never held,
     * `TelemetryUnavailable` when the collector could not be read. Given an effect, it reads the
     * trace list again on every attempt, for a list that can still grow while it waits.
     */
    readonly settled: (
      traces: string | ReadonlyArray<string> | Effect.Effect<ReadonlyArray<string>>,
      ready: (spans: ReadonlyArray<DeliveredSpan>) => boolean,
    ) => Effect.Effect<ReadonlyArray<DeliveredSpan>, TraceUnsettled | TelemetryUnavailable>;
    /** The tags of delivered spans of one operation in `scope` whose attributes match exactly. */
    readonly spans: (
      operation: string,
      scope: SpanScope,
      attributes?: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, string>>>, TelemetryUnavailable>;
    /** Delivered spans of one operation in `scope` whose attributes match exactly. */
    readonly search: (
      operation: string,
      scope: SpanScope,
      attributes?: Readonly<Record<string, string>>,
    ) => Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable>;
    /**
     * Delivered spans of one operation from every scenario that shares this environment's
     * collector: on Cloud, every scenario of the job. Only for a check whose subject is the whole
     * environment, such as a global job or a privacy property no scenario may break.
     */
    readonly searchWholeEnvironment: (
      operation: string,
      attributes: Readonly<Record<string, string>>,
    ) => Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable>;
    /** The delivered log records of one trace, as the collector returns them. */
    readonly logs: (traceId: string) => Effect.Effect<string, TelemetryUnavailable>;
    /**
     * Delivered log records whose body contains `text`, from every scenario that shares this
     * environment's collector. Only for a check that a marker of this scenario's own appears
     * nowhere. Only a collector this suite runs can be read.
     */
    readonly logsWholeEnvironment: (text: string) => Effect.Effect<string, TelemetryUnavailable>;
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
      const attached = target.metadata.target === "cloud" && target.metadata.mode === "attached";
      const origin = fs.readFileString(`${target.directory}/data/diagnostics/collector.json`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))),
        Effect.map((collector) => collector.url),
      );
      const safe = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(() => new TelemetryUnavailable()),
        );
      const read = (url: URL) =>
        Effect.gen(function* () {
          const response = yield* http.get(url.href);
          if (response.status !== 200) return yield* new TelemetryUnavailable();
          return yield* response.text;
        });
      /** One search, in one trace or across them all. */
      const searchIn = (
        operation: string,
        attributes: Readonly<Record<string, string>>,
        traceId: string | undefined,
      ) =>
        attached
          ? cloud
              .search(operation, attributes, traceId)
              .pipe(Effect.mapError(() => new TelemetryUnavailable()))
          : safe(
              Effect.scoped(
                Effect.gen(function* () {
                  const url = new URL("/api/spans/search", yield* origin);
                  url.searchParams.set("operation", operation);
                  url.searchParams.set("lookback", "1d");
                  url.searchParams.set("limit", "10000");
                  if (traceId !== undefined) url.searchParams.set("traceId", traceId);
                  for (const [key, value] of Object.entries(attributes))
                    url.searchParams.set(`attr.${key}`, value);
                  return yield* read(url).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SpanQuery))),
                  );
                }),
              ),
            );
      const search = (
        operation: string,
        scope: SpanScope,
        attributes: Readonly<Record<string, string>> = {},
      ): Effect.Effect<typeof SpanQuery.Type, TelemetryUnavailable> =>
        scopeOf("A span read", scope).pipe(
          Effect.flatMap(({ kind, value }) => {
            if (kind === "traces")
              return typeof value === "string"
                ? Effect.die(new Error("A span read's traces must be a list"))
                : Effect.forEach(
                    [...new Set(value)],
                    (traceId) => searchIn(operation, attributes, traceId),
                    { concurrency: 8 },
                  ).pipe(Effect.map((found) => ({ data: found.flatMap(({ data }) => data) })));
            if (typeof value !== "string")
              return Effect.die(new Error(`A span read's ${kind} must be one ID`));
            if (kind === "organizationPath") {
              if (!/^\/org\/[^/]+\//u.test(value))
                return Effect.die(new Error(`${value} is not an organization's page`));
              return searchIn(operation, { ...attributes, "url.path": value }, undefined);
            }
            const attribute = (ownedIds as Readonly<Record<string, string>>)[kind];
            if (attribute === undefined)
              return Effect.die(new Error(`A span read has no scope named ${kind}`));
            if (attributes[attribute] !== undefined && attributes[attribute] !== value)
              return Effect.die(new Error(`The scope and the attributes name two ${attribute}`));
            return searchIn(operation, { ...attributes, [attribute]: value }, undefined);
          }),
        );
      const query = (id: string) =>
        attached
          ? cloud.trace(id).pipe(Effect.mapError(() => new TelemetryUnavailable()))
          : safe(
              Effect.scoped(
                Effect.gen(function* () {
                  const url = yield* origin;
                  return yield* read(new URL(`/api/traces/${id}/spans`, url)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SpanQuery))),
                  );
                }),
              ),
            );
      const logs = (url: (base: string) => URL) =>
        attached
          ? Effect.fail(new TelemetryUnavailable())
          : safe(Effect.scoped(Effect.flatMap(origin, (base) => read(url(base)))));
      return {
        query,
        settled: (traces, ready) => {
          const list = Effect.isEffect(traces)
            ? traces
            : Effect.succeed(typeof traces === "string" ? [traces] : traces);
          return Effect.gen(function* () {
            const ids = [...new Set(yield* list)];
            yield* scopeOf("A trace wait", { traces: ids });
            const found = yield* Effect.forEach(ids, query, { concurrency: 8 });
            const spans = found.flatMap(({ data }) => data.map(({ span }) => span));
            return ready(spans)
              ? spans
              : yield* Effect.fail(new TraceUnsettled({ traces: ids, spans: spans.length }));
          }).pipe(
            // The last attempt's error stays, so an unreadable collector is not reported as a
            // trace that has not finished arriving.
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
        },
        spans: (operation, scope, attributes) =>
          search(operation, scope, attributes).pipe(
            Effect.map((found) => found.data.map(({ span }) => span.tags)),
          ),
        search,
        searchWholeEnvironment: (operation, attributes) =>
          searchIn(operation, attributes, undefined),
        logs: (traceId) => logs((base) => new URL(`/api/traces/${traceId}/logs`, base)),
        logsWholeEnvironment: (text) =>
          logs((base) => {
            const url = new URL("/api/logs/search", base);
            url.searchParams.set("body", text);
            url.searchParams.set("lookback", "1d");
            return url;
          }),
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
/** The scenario's traces did not finish arriving: `ready` never held for their delivered spans. */
export class TraceUnsettled extends Schema.TaggedError<TraceUnsettled>()("TraceUnsettled", {
  traces: Schema.Array(Schema.String),
  spans: Schema.Number,
}) {}

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
          // before it settles or after. A batch's reads run at once and finish in any order, so
          // one the deadline stops keeps its traces only up to the first it had not read: what is
          // kept is always the newest of the plan, and every trace left unread is older.
          let pending: { readonly index: number; value?: unknown }[] = [];
          const settle = Effect.gen(function* () {
            const values: unknown[] = [];
            for (const { index, value } of pending) {
              if (value === undefined) break;
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
          // The batch the deadline stopped keeps its newest traces that were read.
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
