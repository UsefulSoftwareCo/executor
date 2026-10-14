/** Run the shipped collector as separate processes; query only their public HTTP API. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
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

/** workerd's control message once the collector socket accepts connections. */
const Listening = Schema.Struct({
  event: Schema.Literal("listen"),
  socket: Schema.Literal("motel"),
  port: Schema.Number,
});

/**
 * Serve one Motel from the bundle `e2e:prepare` built, storing its data in `diagnostics/<name>`
 * and its output in `<name>.log`. Every target in a run serves the same bundle directory, and a
 * build replaces it, so nothing in a run builds it.
 */
const serveMotel = (directory: string, name: string, log: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const data = path.join(directory, "data/diagnostics", name);
    yield* fs.makeDirectory(data, { recursive: true });
    const bundle = path.resolve("packages/telemetry/dist/motel");
    if (!(yield* fs.exists(path.join(bundle, "motel.capnp"))))
      return yield* Effect.die("Run bun run e2e:prepare to build the telemetry collector first.");
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
          path.join(bundle, "motel.capnp"),
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

/** One Motel, as a scenario that owns its own collector uses it. */
export const serveOtlpCollector = (directory: string) =>
  Effect.gen(function* () {
    const url = yield* serveMotel(directory, "motel", "collector.log");
    yield* announce(directory, url);
    return url;
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
    const exported = Effect.gen(function* () {
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
