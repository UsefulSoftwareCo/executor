/** A loopback service that saves records at once, or later as a service still finishing a change. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Queue, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

/**
 * A service an app saves records to. `POST /records` saves a record at once, or with `?pending`
 * accepts it to save later, when `commit` runs, as a service still working on a change.
 * `GET /quota?status=` refuses with that status; with `&after=write` it first waits for a pending
 * record to arrive, so the refusal comes while that change is pending. `GET /records` reads the
 * saved records.
 */
export const recordingService = Effect.gen(function* () {
  const saved = yield* Ref.make<ReadonlyArray<string>>([]);
  const pending = yield* Ref.make<ReadonlyArray<string>>([]);
  const arrivals = yield* Queue.unbounded<string>();
  const Record = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));
  const records = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST")
      return yield* HttpServerResponse.json({ records: yield* Ref.get(saved) });
    const { name } = yield* Schema.decodeUnknownEffect(Record)(yield* request.text);
    if (!new URL(request.url, "http://fixture.test").searchParams.has("pending")) {
      yield* Ref.update(saved, (records) => [...records, name]);
      return yield* HttpServerResponse.json({ saved: name }, { status: 201 });
    }
    yield* Ref.update(pending, (records) => [...records, name]);
    yield* Queue.offer(arrivals, name);
    return yield* HttpServerResponse.json({ accepted: name }, { status: 202 });
  });
  const quota = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = new URL(request.url, "http://fixture.test").searchParams;
    if (query.get("after") === "write")
      yield* Queue.take(arrivals).pipe(Effect.timeout("10 seconds"));
    return yield* HttpServerResponse.json({}, { status: Number(query.get("status")) });
  });
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("*", "/records", records),
        HttpRouter.add("GET", "/quota", quota),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    url: `http://127.0.0.1:${server.address.port}`,
    /** The records the service saved, in order. */
    saved: Ref.get(saved),
    /** Save the pending records, as the service finishing its work. */
    commit: Ref.getAndSet(pending, []).pipe(
      Effect.flatMap((committed) => Ref.update(saved, (records) => [...records, ...committed])),
    ),
  };
});
