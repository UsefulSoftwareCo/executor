/** Observe Cloud's stored working source through delivered request traces. */
import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { Evidence, Telemetry } from "./evidence.ts";

export type Spans = ReadonlyArray<{
  readonly span: {
    readonly spanId: string;
    readonly parentSpanId: string | null;
    readonly operationName: string;
    readonly tags: Readonly<Record<string, string>>;
  };
}>;

export const named = (spans: Spans, name: string) =>
  spans.filter(({ span }) => span.operationName === name);

/** The stored-workspace outcome of the request's read: "hit" or "miss". */
export const cacheOutcome = (spans: Spans) =>
  named(spans, "source.workspace.cache.read")[0]?.span.tags["source.workspace.cache"];

/** Git and credential spans reached from a stored read must run only in its background check. */
export const outsideRevalidation = (spans: Spans) => {
  const byId = new Map(spans.map(({ span }) => [span.spanId, span]));
  const revalidating = (id: string | null): boolean => {
    const span = id === null ? undefined : byId.get(id);
    if (span === undefined) return false;
    return (
      span.operationName === "source.workspace.cache.revalidate" || revalidating(span.parentSpanId)
    );
  };
  return spans
    .filter(
      ({ span }) =>
        (span.operationName.startsWith("source.git.") ||
          span.operationName.startsWith("source.repository.")) &&
        !revalidating(span.spanId),
    )
    .map(({ span }) => span.operationName);
};

/** Wait for the latest request's spans, including background work that ends after the response. */
export const settledTrace = (label: string, required: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const telemetry = yield* Telemetry;
    const request = (yield* evidence.requests).at(-1);
    if (request === undefined) return yield* Effect.fail(new Error("Missing request evidence"));
    const result = yield* telemetry.query(request.traceId).pipe(
      Effect.flatMap((result) =>
        required.every((name) => named(result.data, name).length > 0)
          ? Effect.succeed(result)
          : Effect.fail(new Error(`Missing ${required.join(", ")}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
    );
    yield* evidence.json(`${label}-trace.json`, result);
    return result.data;
  });

/**
 * Leave Cloud's stored workspace current, so the next read is served without Git.
 * `read` must issue one request and return its snapshot.
 */
export const storedWorkspace = <A, E, R>(
  label: string,
  read: Effect.Effect<A, E, R>,
  expected: A,
) =>
  Effect.gen(function* () {
    expect(yield* read).toEqual(expected);
    const first = yield* settledTrace(`${label}-read`, ["source.workspace.cache.read"]);
    if (cacheOutcome(first) === "miss") {
      // Another read may store the same snapshot first; either way the save has finished.
      yield* settledTrace(`${label}-save`, ["source.workspace.cache.save"]);
      expect(yield* read).toEqual(expected);
    }
    // The hit's head check runs after the response. Until its span arrives, the Git and
    // credential spans it started have no delivered parent and look like work outside it.
    const hit = yield* settledTrace(`${label}-hit`, [
      "source.workspace.cache.read",
      "source.workspace.cache.revalidate",
      "source.git.refs",
    ]);
    expect(cacheOutcome(hit)).toBe("hit");
    expect(outsideRevalidation(hit)).toEqual([]);
  });
