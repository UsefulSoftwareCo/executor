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

export const cacheOutcome = (spans: Spans) =>
  named(spans, "source.workspace.cache.read")[0]?.span.tags["source.workspace.cache"];

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

export const storedWorkspace = <A, E, R>(
  label: string,
  read: Effect.Effect<A, E, R>,
  expected: A,
) =>
  Effect.gen(function* () {
    expect(yield* read).toEqual(expected);
    const first = yield* settledTrace(`${label}-read`, ["source.workspace.cache.read"]);
    if (cacheOutcome(first) === "miss") {
      yield* settledTrace(`${label}-save`, ["source.workspace.cache.save"]);
      expect(yield* read).toEqual(expected);
    }
    const hit = yield* settledTrace(`${label}-hit`, [
      "source.workspace.cache.read",
      "source.workspace.cache.revalidate",
      "source.git.refs",
    ]);
    expect(cacheOutcome(hit)).toBe("hit");
    expect(outsideRevalidation(hit)).toEqual([]);
  });
