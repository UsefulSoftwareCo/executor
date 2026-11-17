/** Run the shipped collector as separate processes; query only their public HTTP API. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Stream } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:http";
import { SpanQuery } from "./contracts.ts";
import { refuseTruncated, searchLimit } from "./evidence.ts";

/** The collector's one line on stdout once it accepts connections on its TCP port. */
const Listening = Schema.Struct({ event: Schema.Literal("listening"), port: Schema.Number });

/** Bounds a scenario sets on its own collector, as the collector's flags name them. */
export interface CollectorBounds {
  readonly maxStoreMb?: number | undefined;
  readonly retentionHours?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly maxExportBytes?: number | undefined;
}

/**
 * Serve one collector from the build `e2e:prepare` made, storing its data in `diagnostics/<name>`
 * and its log in `<name>.log`. Every target in a run starts the same executable, and a build
 * replaces it, so nothing in a run builds it. `bounds` are passed as its flags; the rest keep the
 * collector's defaults, which are the product's.
 */
const serveCollector = (
  directory: string,
  name: string,
  log: string,
  bounds: CollectorBounds = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const data = path.join(directory, "data/diagnostics", name);
    yield* fs.makeDirectory(data, { recursive: true });
    const executable = path.resolve(
      "packages/telemetry/dist/collector",
      process.platform === "win32" ? "executor-collector.exe" : "executor-collector",
    );
    if (!(yield* fs.exists(executable)))
      return yield* Effect.die("Run bun run e2e:prepare to build the telemetry collector first.");
    const flags = [
      ["--max-store-mb", bounds.maxStoreMb],
      ["--retention-hours", bounds.retentionHours],
      ["--max-pending", bounds.maxPending],
      ["--max-export-bytes", bounds.maxExportBytes],
    ].flatMap(([flag, value]) => (value === undefined ? [] : [`${flag}=${value}`]));
    const child = yield* processes.spawn(
      ChildProcess.make(executable, ["serve", `--data=${data}`, "--listen=127.0.0.1:0", ...flags], {
        cwd: directory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // It stops within 2.5 seconds of SIGTERM.
        forceKillAfter: "3 seconds",
      }),
    );
    yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((text) =>
        fs.writeFileString(path.join(directory, log), text, { flag: "a", mode: 0o600 }),
      ),
      Effect.forkScoped,
    );
    const ready = yield* Deferred.make<string>();
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Listening))(line).pipe(
          Effect.flatMap(({ port }) => Deferred.succeed(ready, `http://127.0.0.1:${port}`)),
          Effect.ignore,
        ),
      ),
      Effect.forkScoped,
    );
    // The listening line, or the collector's exit if it could not start: it says why in its log.
    return yield* Deferred.await(ready).pipe(
      Effect.raceFirst(
        child.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.die(`The collector exited ${code} before listening; see ${log}.`),
          ),
        ),
      ),
      Effect.timeout("20 seconds"),
    );
  });

/** Name the collector's query URL in `data/diagnostics/collector.json`, where readers find it. */
const announce = (directory: string, url: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(directory, "data/diagnostics/collector.json"),
      JSON.stringify({ state: "running", url }),
      { mode: 0o600 },
    );
  });

/** One collector, as a scenario that owns its own collector uses it, with any `bounds` it sets. */
export const serveOtlpCollector = (directory: string, bounds: CollectorBounds = {}) =>
  Effect.gen(function* () {
    const url = yield* serveCollector(directory, "collector", "collector.log", bounds);
    yield* announce(directory, url);
    return url;
  });

/**
 * The spans a collector this scenario served itself (`serveOtlpCollector`) holds that started in
 * [from, to), of one operation or all, newest first. That collector receives only this scenario's
 * servers, so all of it is the scenario's.
 */
export const ownCollectorSpans = (
  collector: string,
  window: { readonly from: number; readonly to: number; readonly operation?: string | undefined },
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const url = new URL("/api/spans/search", collector);
        if (window.operation !== undefined) url.searchParams.set("operation", window.operation);
        // The collector looks back whole minutes from now: as few as cover the window's start.
        const minutes = Math.max(1, Math.ceil((Date.now() - window.from) / 60_000) + 1);
        url.searchParams.set("lookback", `${minutes}m`);
        url.searchParams.set("limit", String(searchLimit));
        const response = yield* http.get(url.href);
        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SpanQuery)),
          Effect.tap((found) => refuseTruncated(found, url)),
        );
      }),
    ).pipe(
      Effect.map(({ data }) =>
        data.filter(({ span }) => {
          const at = Date.parse(span.startTime);
          return at >= window.from && at < window.to;
        }),
      ),
    );
  });

const Json = Schema.Record(Schema.String, Schema.Json);
/** An OTLP JSON record, keeping every field; only its trace ID is read. */
const Traced = Schema.StructWithRest(Schema.Struct({ traceId: Schema.optional(Schema.String) }), [
  Json,
]);
const TraceExport = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      resourceSpans: Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            scopeSpans: Schema.Array(
              Schema.StructWithRest(Schema.Struct({ spans: Schema.Array(Traced) }), [Json]),
            ),
          }),
          [Json],
        ),
      ),
    }),
    [Json],
  ),
);
const LogExport = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      resourceLogs: Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            scopeLogs: Schema.Array(
              Schema.StructWithRest(Schema.Struct({ logRecords: Schema.Array(Traced) }), [Json]),
            ),
          }),
          [Json],
        ),
      ),
    }),
    [Json],
  ),
);
/** The parts of a query answer the router merges: its items, and the limit that bounds them. */
const Listing = Schema.StructWithRest(Schema.Struct({ data: Schema.Array(Schema.Json) }), [Json]);
const SpanItem = Schema.Struct({ span: Schema.Struct({ startTime: Schema.String }) });
/** A list the collector cut off at its limit. */
const Truncated = Schema.Struct({ meta: Schema.Struct({ truncated: Schema.Literal(true) }) });

/**
 * Which collector holds a trace. OTLP JSON names a trace in hex, or in base64 from exporters that
 * follow protobuf's JSON mapping; both name the same 16 bytes.
 */
const shardOf = (traceId: string | undefined, shards: number) => {
  if (traceId === undefined || traceId === "") return 0;
  const hex = /^[0-9a-f]{32}$/i.test(traceId)
    ? traceId.toLowerCase()
    : Buffer.from(traceId, "base64").toString("hex");
  return Number.parseInt(hex.slice(-8), 16) % shards;
};

/**
 * Several collectors behind one OTLP and query endpoint, each holding the traces whose ID it is
 * given.
 *
 * The managed Cloud job's six workers export together while they provision their organizations.
 * Motel, the collector this harness first ran, stored about 1,500 spans a second and refused them;
 * so the job split the traces over several. The Rust collector stores about 24,000 spans a second
 * on a desktop (its README, "Disk use and the write-ahead log"); whether one would keep up with the
 * job has not been measured, so the split and its count are unchanged.
 *
 * Each export is split by trace and sent to the collectors holding those traces. When one refuses its
 * part, the export is answered with that refusal, so the exporter resends it as it would to one
 * collector; spans are stored by their IDs, so the parts already stored are replaced, not repeated. A
 * trace's reads go to its collector; a search across traces asks every collector and merges the
 * answers.
 */
export const serveShardedOtlpCollector = (directory: string, shards: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const collectors = yield* Effect.forEach(
      Array.from({ length: shards }, (_, index) => index),
      (index) => serveCollector(directory, `collector-${index}`, `collector-${index}.log`),
      { concurrency: "unbounded" },
    );
    const answer = (response: HttpClientResponse.HttpClientResponse) =>
      response.arrayBuffer.pipe(
        Effect.map((bytes) =>
          HttpServerResponse.uint8Array(new Uint8Array(bytes), {
            status: response.status,
            contentType: response.headers["content-type"],
            headers:
              response.headers["retry-after"] === undefined
                ? {}
                : { "retry-after": response.headers["retry-after"] },
          }),
        ),
      );
    const post = (collector: string, path: string, body: HttpBody.HttpBody) =>
      Effect.scoped(
        http.post(new URL(path, collector).href, { body }).pipe(Effect.flatMap(answer)),
      );
    const get = (collector: string, url: string) =>
      Effect.scoped(http.get(new URL(url, collector).href).pipe(Effect.flatMap(answer)));

    /** Send each collector its part; the first refusal, if any, answers the whole export. */
    const ingest = (parts: ReadonlyMap<number, unknown>, path: string) =>
      Effect.forEach(
        [...parts],
        ([shard, part]) => post(collectors[shard]!, path, HttpBody.jsonUnsafe(part)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(
          (answers) =>
            answers.find(({ status }) => status === 429 || status === 503) ??
            answers.find(({ status }) => status !== 200) ??
            HttpServerResponse.jsonUnsafe({}),
        ),
      );
    const split = <R extends { readonly traceId?: string | undefined }, S, C>(
      resources: ReadonlyArray<S>,
      scopes: (resource: S) => ReadonlyArray<C>,
      records: (scope: C) => ReadonlyArray<R>,
      rebuild: (resource: S, scopes: ReadonlyArray<C>) => S,
      rescope: (scope: C, records: ReadonlyArray<R>) => C,
    ) => {
      const parts = new Map<number, Array<S>>();
      for (const resource of resources)
        for (const shard of new Set(
          scopes(resource).flatMap((scope) =>
            records(scope).map((record) => shardOf(record.traceId, shards)),
          ),
        ))
          parts.set(shard, [
            ...(parts.get(shard) ?? []),
            rebuild(
              resource,
              scopes(resource).map((scope) =>
                rescope(
                  scope,
                  records(scope).filter((record) => shardOf(record.traceId, shards) === shard),
                ),
              ),
            ),
          ]);
      return parts;
    };
    // The spans received for the traces a scenario watches, by trace and span ID, so it can tell a
    // span exported twice. Only watched traces are counted; `*` watches every trace, for a scenario
    // whose Cloud serves it alone.
    const watched = new Map<string, Map<string, number>>();
    const watch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const trace = new URL(request.url, "http://collector").searchParams.get("trace") ?? "";
      if (!watched.has(trace)) watched.set(trace, new Map());
      return HttpServerResponse.empty({ status: 204 });
    });
    const received = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const trace = new URL(request.url, "http://collector").searchParams.get("trace") ?? "";
      const seen = [...(watched.get(trace) ?? new Map<string, number>()).values()];
      return HttpServerResponse.jsonUnsafe({
        spans: seen.length,
        duplicated: seen.filter((count) => count > 1).length,
      });
    });
    // While a scenario holds exports, each one is accepted and left unanswered until it releases
    // them, as an endpoint that hangs; the exporter's own deadline gives up on it first.
    const held = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
    const hold = Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      yield* Ref.set(held, Option.some(released));
      return HttpServerResponse.empty({ status: 204 });
    });
    const release = Effect.gen(function* () {
      const current = yield* Ref.getAndSet(held, Option.none());
      if (Option.isSome(current)) yield* Deferred.succeed(current.value, undefined);
      return HttpServerResponse.empty({ status: 204 });
    });
    // While a scenario refuses exports, each one is answered 503 with the Retry-After it names, as
    // a collector shedding load does, and is not stored.
    const refusing = yield* Ref.make(Option.none<string>());
    const refuse = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const after = new URL(request.url, "http://collector").searchParams.get("retryAfter") ?? "1";
      yield* Ref.set(refusing, Option.some(after));
      return HttpServerResponse.empty({ status: 204 });
    });
    const accept = Ref.set(refusing, Option.none()).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204 })),
    );
    const exported = Effect.gen(function* () {
      const refused = yield* Ref.get(refusing);
      if (Option.isSome(refused))
        return HttpServerResponse.empty({ status: 503, headers: { "retry-after": refused.value } });
      const holding = yield* Ref.get(held);
      if (Option.isSome(holding)) {
        yield* Deferred.await(holding.value);
        return HttpServerResponse.empty({ status: 503 });
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      const text = new TextDecoder().decode(bytes);
      const path = new URL(request.url, "http://collector").pathname;
      const unchanged = post(
        collectors[0]!,
        path,
        HttpBody.uint8Array(bytes, request.headers["content-type"]),
      );
      if (path === "/v1/traces") {
        const decoded = Schema.decodeUnknownOption(TraceExport)(text);
        if (decoded._tag === "None") return yield* unchanged;
        for (const resource of decoded.value.resourceSpans)
          for (const scope of resource.scopeSpans)
            for (const span of scope.spans) {
              const id = `${span.traceId ?? ""}:${String(span["spanId"] ?? "")}`;
              for (const seen of [watched.get(span.traceId ?? ""), watched.get("*")])
                seen?.set(id, (seen.get(id) ?? 0) + 1);
            }
        const parts = split(
          decoded.value.resourceSpans,
          (resource) => resource.scopeSpans,
          (scope) => scope.spans,
          (resource, scopeSpans) => ({ ...resource, scopeSpans }),
          (scope, spans) => ({ ...scope, spans }),
        );
        return yield* ingest(
          new Map([...parts].map(([shard, resourceSpans]) => [shard, { resourceSpans }])),
          path,
        );
      }
      if (path === "/v1/logs") {
        const decoded = Schema.decodeUnknownOption(LogExport)(text);
        if (decoded._tag === "None") return yield* unchanged;
        const parts = split(
          decoded.value.resourceLogs,
          (resource) => resource.scopeLogs,
          (scope) => scope.logRecords,
          (resource, scopeLogs) => ({ ...resource, scopeLogs }),
          (scope, logRecords) => ({ ...scope, logRecords }),
        );
        return yield* ingest(
          new Map([...parts].map(([shard, resourceLogs]) => [shard, { resourceLogs }])),
          path,
        );
      }
      return yield* unchanged;
    });

    /** A trace's reads go to the collector holding it. */
    const trace = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const id = new URL(request.url, "http://collector").pathname.split("/")[3];
      return yield* get(collectors[shardOf(id, shards)]!, request.url);
    });
    /** A search names one trace, or asks every collector and returns the newest matches first. */
    const search = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://collector");
      const traceId = url.searchParams.get("traceId");
      if (traceId !== null) return yield* get(collectors[shardOf(traceId, shards)]!, request.url);
      // Each collector's matches, or the answer of the first that could not search.
      const answers = yield* Effect.forEach(
        collectors,
        (collector) =>
          Effect.scoped(
            http
              .get(new URL(request.url, collector).href)
              .pipe(
                Effect.flatMap(
                  (
                    response,
                  ): Effect.Effect<
                    typeof Listing.Type | HttpServerResponse.HttpServerResponse,
                    HttpClientError.HttpClientError | Schema.SchemaError
                  > =>
                    response.status === 200
                      ? HttpClientResponse.schemaBodyJson(Listing)(response)
                      : answer(response),
                ),
              ),
          ),
        { concurrency: "unbounded" },
      );
      const listings: Array<typeof Listing.Type> = [];
      for (const found of answers) {
        if (HttpServerResponse.isHttpServerResponse(found)) return found;
        listings.push(found);
      }
      const start = (item: Schema.Json) =>
        Schema.decodeUnknownOption(SpanItem)(item).pipe((found) =>
          found._tag === "Some" ? found.value.span.startTime : "",
        );
      const limit = Number(url.searchParams.get("limit") ?? Number.POSITIVE_INFINITY);
      const matched = listings
        .flatMap((listing) => listing.data)
        .sort((a, b) => start(b).localeCompare(start(a)));
      const data = matched.slice(0, limit);
      // Cut off when any collector had more than it returned, or the merge kept fewer than matched.
      const truncated =
        matched.length > data.length ||
        listings.some((listing) =>
          Schema.decodeUnknownOption(Truncated)(listing).pipe(Option.isSome),
        );
      return HttpServerResponse.jsonUnsafe({ data, meta: { truncated, returned: data.length } });
    });
    const ingestStatus = Effect.forEach(collectors, (collector) =>
      Effect.scoped(
        http.get(new URL("/api/ingest", collector).href).pipe(Effect.flatMap((r) => r.json)),
      ),
    ).pipe(Effect.map((shards) => HttpServerResponse.jsonUnsafe({ shards })));

    const services = yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add("POST", "/v1/*", exported),
          HttpRouter.add("GET", "/api/traces/search", search),
          HttpRouter.add("GET", "/api/traces/*", trace),
          HttpRouter.add("GET", "/api/spans/search", search),
          HttpRouter.add("GET", "/api/logs/search", search),
          HttpRouter.add("GET", "/api/ingest", ingestStatus),
          HttpRouter.add("POST", "/api/e2e/exports/hold", hold),
          HttpRouter.add("POST", "/api/e2e/exports/release", release),
          HttpRouter.add("POST", "/api/e2e/exports/refuse", refuse),
          HttpRouter.add("POST", "/api/e2e/exports/accept", accept),
          HttpRouter.add("POST", "/api/e2e/exports/watch", watch),
          HttpRouter.add("GET", "/api/e2e/exports/received", received),
        ),
        { disableLogger: true, disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address))
      return yield* Effect.die("Collector router must listen on TCP");
    const url = `http://127.0.0.1:${server.address.port}`;
    yield* announce(directory, url);
    return url;
  });
