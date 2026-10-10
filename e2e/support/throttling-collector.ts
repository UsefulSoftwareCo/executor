/**
 * A scenario-owned OTLP destination: its own Motel behind a proxy that refuses chosen exports the
 * way a collector shedding load does. Exports carrying no planned marker, and a marked export once
 * its refusals run out, reach Motel unchanged. Nothing is shared with the target's collector.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Effect, FileSystem, Layer, Ref, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { createServer } from "node:http";
import { SpanQuery } from "./contracts.ts";
import { serveOtlpCollector } from "./otlp-collector.ts";
import { Target } from "./platform.ts";

/** One refused export: its status and the Retry-After it names, given the refusal time. */
export interface Refusal {
  readonly status: number;
  readonly retryAfter?: (now: number) => string;
}

/** When a marked export reached the proxy, and the status the proxy answered. */
export interface Arrival {
  readonly at: number;
  readonly status: number;
}

/** The parts of an OTLP JSON trace export that name its apps and traces. */
const AppTraceExport = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        resource: Schema.optional(
          Schema.Struct({
            attributes: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  key: Schema.String,
                  value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
                }),
              ),
            ),
          }),
        ),
        scopeSpans: Schema.optional(
          Schema.Array(
            Schema.Struct({
              spans: Schema.optional(Schema.Array(Schema.Struct({ traceId: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  }),
);

/** Start both in the caller's scope, which stops them. */
export const throttlingCollector = Effect.gen(function* () {
  const target = yield* Target,
    fs = yield* FileSystem.FileSystem,
    http = yield* HttpClient.HttpClient;
  const directory = yield* fs.makeTempDirectory({
    directory: target.directory,
    prefix: "collector",
  });
  const motel = yield* serveOtlpCollector(directory);
  const plans = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<Refusal>>>(new Map());
  const arrivals = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<Arrival>>>(new Map());
  const appTraces = yield* Ref.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  /** Record the traces of app isolate spans that reached Motel, by the app they came from. */
  const recordAppTraces = (text: string) =>
    Ref.update(appTraces, (all) => {
      const decoded = Schema.decodeUnknownOption(AppTraceExport)(text);
      if (decoded._tag === "None") return all;
      const next = new Map(all);
      for (const { resource, scopeSpans } of decoded.value.resourceSpans) {
        const attribute = (key: string) =>
          resource?.attributes?.find((entry) => entry.key === key)?.value.stringValue;
        const app = attribute("executor.app.id");
        if (attribute("service.name") !== "executor-app" || app === undefined) continue;
        const traces = new Set(next.get(app) ?? []);
        for (const scope of scopeSpans ?? [])
          for (const span of scope.spans ?? []) traces.add(span.traceId);
        next.set(app, traces);
      }
      return next;
    });
  const forward = (path: string, bytes: Uint8Array, contentType: string | undefined) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.post(new URL(path, motel).href, {
          body: HttpBody.uint8Array(bytes, contentType),
        });
        return HttpServerResponse.uint8Array(new Uint8Array(yield* response.arrayBuffer), {
          status: response.status,
          contentType: response.headers["content-type"],
        });
      }),
    );
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const bytes = new Uint8Array(yield* request.arrayBuffer);
    const now = yield* Clock.currentTimeMillis;
    const text = new TextDecoder().decode(bytes);
    const marker = [...(yield* Ref.get(plans)).keys()].find((key) => text.includes(key));
    const contentType = request.headers["content-type"];
    const forwarded = (path: string) =>
      forward(path, bytes, contentType).pipe(
        Effect.tap((response) =>
          response.status === 200 && path === "/v1/traces" ? recordAppTraces(text) : Effect.void,
        ),
      );
    if (marker === undefined) return yield* forwarded(request.url);
    const refusal = yield* Ref.modify(plans, (all) => {
      const [next, ...rest] = all.get(marker) ?? [];
      return [next, new Map(all).set(marker, rest)];
    });
    const response =
      refusal === undefined
        ? yield* forwarded(request.url)
        : HttpServerResponse.empty({
            status: refusal.status,
            headers:
              refusal.retryAfter === undefined ? {} : { "retry-after": refusal.retryAfter(now) },
          });
    yield* Ref.update(arrivals, (all) =>
      new Map(all).set(marker, [...(all.get(marker) ?? []), { at: now, status: response.status }]),
    );
    return response;
  });
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("POST", "/*", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Collector proxy must listen on TCP");
  return {
    /** The OTLP base URL the product exports to. */
    endpoint: `http://127.0.0.1:${server.address.port}`,
    /** Answer the next exports containing `marker` with these refusals, in order. */
    refuse: (marker: string, refusals: ReadonlyArray<Refusal>) =>
      Ref.update(plans, (all) => new Map(all).set(marker, refusals)),
    /** Every export containing `marker` that reached the proxy. */
    arrivals: (marker: string) =>
      Ref.get(arrivals).pipe(Effect.map((all) => all.get(marker) ?? [])),
    /** The traces whose app isolate spans for `app` reached Motel. */
    appTraces: (app: string) =>
      Ref.get(appTraces).pipe(Effect.map((all) => all.get(app) ?? new Set<string>())),
    /** The spans of one trace that Motel stored. */
    query: (traceId: string) =>
      Effect.scoped(
        http.get(new URL(`/api/traces/${traceId}/spans`, motel).href).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(SpanQuery)),
        ),
      ),
  };
});
