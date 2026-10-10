/**
 * Evaluated declarations and tool listings kept in each app's data supervisor, beside the app
 * cache that already holds its account-scoped upstream metadata, so they outlive the process or
 * isolate that evaluated them.
 */
import { Clock, Effect, Schema } from "effect";
import {
  EvaluatedEntry,
  EvaluatedWritten,
  evaluatedLimits,
  type EvaluatedCommand,
  type EvaluatedSupervisor,
} from "@executor-js/app-data/evaluated";
import type { DurableDeclarations } from "../contracts/declarations.ts";

class CompressionFailed extends Schema.TaggedError<CompressionFailed>()("CompressionFailed", {}) {}

/**
 * A waking supervisor answers most reads in tens of milliseconds, and some in seconds. A read
 * slower than this costs about what the evaluation it would spare does, so it counts as a miss.
 */
const readMillis = 2_000;

const transform = (body: BodyInit, stream: CompressionStream | DecompressionStream) =>
  Effect.tryPromise({
    try: () => new Response(new Response(body).body?.pipeThrough(stream)).arrayBuffer(),
    catch: () => new CompressionFailed(),
  });

/**
 * Milliseconds `effect` took on this isolate's clock, which only advances on I/O. It measures the
 * supervisor round trip; CPU-bound work such as gzip would read near 0 on deployed Workers, so
 * that is reported by its sizes (`bytes`, `chars`) instead of a duration.
 */
const timed = <A, E, R>(attribute: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const from = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    yield* Effect.annotateCurrentSpan(attribute, (yield* Clock.currentTimeMillis) - from);
    return value;
  });

/** Whether the command woke the supervisor and how long it and its isolate had been running. */
const annotateSupervisor = (supervisor: EvaluatedSupervisor | undefined) =>
  supervisor === undefined
    ? Effect.void
    : Effect.annotateCurrentSpan({
        "storage.evaluated.supervisor.woke": supervisor.woke,
        "storage.evaluated.supervisor.instance_ms": supervisor.instanceMs,
        "storage.evaluated.supervisor.isolate_ms": supervisor.isolateMs,
      });

/**
 * `send` delivers one command to the app's supervisor and answers with its reply. Bodies are
 * compressed here, so every host's supervisor keeps the same entries.
 */
export const evaluatedDeclarations = <E>(
  send: (app: string, command: EvaluatedCommand) => Effect.Effect<unknown, E>,
): DurableDeclarations => ({
  get: (app, key) =>
    Effect.gen(function* () {
      const reply = yield* timed("storage.evaluated.rpc_ms", send(app, { operation: "read", key }));
      const entry = yield* Schema.decodeUnknownEffect(EvaluatedEntry)(reply);
      const found = entry !== null && "body" in entry;
      yield* Effect.annotateCurrentSpan("storage.evaluated.found", found);
      if (entry !== null) yield* annotateSupervisor(entry.supervisor);
      if (!found) return undefined;
      yield* Effect.annotateCurrentSpan("storage.evaluated.bytes", entry.body.byteLength);
      const text = new TextDecoder().decode(
        yield* transform(Uint8Array.from(entry.body), new DecompressionStream("gzip")),
      );
      yield* Effect.annotateCurrentSpan("storage.evaluated.chars", text.length);
      return { at: entry.at, json: text };
    }).pipe(
      Effect.timeout(readMillis),
      Effect.catchCause(() => Effect.succeed(undefined)),
      Effect.withSpan("storage.evaluated.read", { attributes: { "executor.app.id": app } }),
    ),
  set: (app, key, entry) =>
    Effect.gen(function* () {
      const body = new Uint8Array(yield* transform(entry.json, new CompressionStream("gzip")));
      yield* Effect.annotateCurrentSpan("storage.evaluated.bytes", body.byteLength);
      if (body.byteLength > evaluatedLimits.entryBytes) return;
      const reply = yield* timed(
        "storage.evaluated.rpc_ms",
        send(app, { operation: "write", key, at: entry.at, until: entry.until, body }),
      );
      // Supervisors from before replies carried their state answer a bare boolean.
      const written = Schema.decodeUnknownOption(EvaluatedWritten)(reply);
      if (written._tag === "Some") {
        yield* Effect.annotateCurrentSpan("storage.evaluated.kept", written.value.kept);
        yield* annotateSupervisor(written.value.supervisor);
      }
    }).pipe(
      Effect.catchCause(() => Effect.logWarning("Evaluated result was not kept")),
      Effect.withSpan("storage.evaluated.write", { attributes: { "executor.app.id": app } }),
    ),
});
