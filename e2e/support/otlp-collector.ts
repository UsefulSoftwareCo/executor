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

/** workerd's control message once the collector socket accepts connections. */
const Listening = Schema.Struct({
  event: Schema.Literal("listen"),
  socket: Schema.Literal("motel"),
  port: Schema.Number,
});

/**
 * Serve one Motel from the bundle `e2e:prepare` built, storing its data in `diagnostics/<name>`
 * and its output in `<name>.log`. Every target in a run serves the same bundle directory, and a
 * build replaces it, so nothing in a run builds it. `bounds` replaces the values of the bundle's
 * own `MOTEL_OTEL_*` settings in a copy of its config, beside a copy of its worker.
 */
const serveMotel = (
  directory: string,
  name: string,
  log: string,
  bounds: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const data = path.join(directory, "data/diagnostics", name);
    yield* fs.makeDirectory(data, { recursive: true });
    const bundle = path.resolve("packages/telemetry/dist/motel");
    if (!(yield* fs.exists(path.join(bundle, "motel.capnp"))))
      return yield* Effect.die("Run bun run e2e:prepare to build the telemetry collector first.");
    let config = path.join(bundle, "motel.capnp");
    if (Object.keys(bounds).length > 0) {
      let text = yield* fs.readFileString(config);
      for (const [setting, value] of Object.entries(bounds)) {
        const binding = `(name="${setting}",text="`;
        if (!text.includes(binding))
          return yield* Effect.die(`The collector's config has no ${setting} setting.`);
        text = text.replace(
          new RegExp(`\\(name="${setting}",text="[^"]*"\\)`),
          `${binding}${value}")`,
        );
      }
      config = path.join(directory, `${name}.capnp`);
      yield* fs.writeFileString(config, text, { mode: 0o600 });
      yield* fs.copyFile(path.join(bundle, "motel.mjs"), path.join(directory, "motel.mjs"));
    }
    // The bundle's config names its directories and socket; this supplies their paths and a free port.
    const child = yield* processes.spawn(
      ChildProcess.make(
        path.resolve("node_modules/.bin", process.platform === "win32" ? "workerd.exe" : "workerd"),
        [
          "serve",
          "--control-fd=3",
          `--directory-path=motel-data=${data}`,
          `--directory-path=motel-assets=${path.join(bundle, "web/dist")}`,
          "--socket-addr=motel=127.0.0.1:0",
          config,
        ],
        {
          cwd: data,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          additionalFds: { fd3: { type: "output" } },
          forceKillAfter: "3 seconds",
        },
      ),
    );
    yield* Effect.forEach(
      [child.stdout, child.stderr],
      (output) =>
        output.pipe(
          Stream.decodeText,
          Stream.runForEach((text) =>
            fs.writeFileString(path.join(directory, log), text, { flag: "a", mode: 0o600 }),
          ),
          Effect.forkScoped,
        ),
      { discard: true },
    );
    const ready = yield* Deferred.make<string>();
    yield* child.getOutputFd(3).pipe(
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
    return yield* Deferred.await(ready).pipe(Effect.timeout("20 seconds"));
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

/** One Motel, as a scenario that owns its own collector uses it, with any `bounds` it sets. */
export const serveOtlpCollector = (
  directory: string,
  bounds: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const url = yield* serveMotel(directory, "motel", "collector.log", bounds);
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
        url.searchParams.set("lookback", "1h");
        url.searchParams.set("limit", "10000");
        const response = yield* http.get(url.href);
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SpanQuery)));
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
 * Several Motels behind one OTLP and query endpoint, each holding the traces whose ID it is given.
 *
 * One Motel stores about 1,500 spans a second: SQLite indexes every attribute of every span on a
 * single thread. The managed Cloud job's six workers send more than that while they provision their
 * organizations, so one collector refused exports with 429 until the product's three-second export
 * budget ran out and dropped them, and scenarios waiting for those spans failed. A deployed stage
 * exports to a collector that keeps up. Splitting the traces gives each Motel a share of the load and
 * of the data its queries read.
 *
 * Each export is split by trace and sent to the Motels holding those traces. When one refuses its
 * part, the export is answered with that refusal, so the exporter resends it as it would to one
 * Motel; spans are stored by their IDs, so the parts already stored are replaced, not repeated. A
 * trace's reads go to its Motel; a search across traces asks every Motel and merges the answers.
 */
export const serveShardedOtlpCollector = (directory: string, shards: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const motels = yield* Effect.forEach(
      Array.from({ length: shards }, (_, index) => index),
      (index) => serveMotel(directory, `motel-${index}`, `collector-${index}.log`),
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
    const post = (motel: string, path: string, body: HttpBody.HttpBody) =>
      Effect.scoped(http.post(new URL(path, motel).href, { body }).pipe(Effect.flatMap(answer)));
    const get = (motel: string, url: string) =>
      Effect.scoped(http.get(new URL(url, motel).href).pipe(Effect.flatMap(answer)));

    /** Send each Motel its part; the first refusal, if any, answers the whole export. */
    const ingest = (parts: ReadonlyMap<number, unknown>, path: string) =>
      Effect.forEach(
        [...parts],
        ([shard, part]) => post(motels[shard]!, path, HttpBody.jsonUnsafe(part)),
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
        motels[0]!,
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

    /** A trace's reads go to the Motel holding it. */
    const trace = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const id = new URL(request.url, "http://collector").pathname.split("/")[3];
      return yield* get(motels[shardOf(id, shards)]!, request.url);
    });
    /** A search names one trace, or asks every Motel and returns the newest matches first. */
    const search = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://collector");
      const traceId = url.searchParams.get("traceId");
      if (traceId !== null) return yield* get(motels[shardOf(traceId, shards)]!, request.url);
      // Each Motel's matches, or the answer of the first that could not search.
      const answers = yield* Effect.forEach(
        motels,
        (motel) =>
          Effect.scoped(
            http
              .get(new URL(request.url, motel).href)
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
      const data = listings
        .flatMap((listing) => listing.data)
        .sort((a, b) => start(b).localeCompare(start(a)))
        .slice(0, limit);
      return HttpServerResponse.jsonUnsafe({ data });
    });
    const ingestStatus = Effect.forEach(motels, (motel) =>
      Effect.scoped(
        http.get(new URL("/api/ingest", motel).href).pipe(Effect.flatMap((r) => r.json)),
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
