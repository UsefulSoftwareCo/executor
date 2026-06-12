import { Effect, Exit, Predicate, Tracer } from "effect";

/* Telemetry contract testing: a Tracer that records every span it creates so
 * tests can assert spans, attributes, and error statuses actually exist for a
 * given operation. The product's biggest observability failure mode is the
 * signal silently going dark (a span attribute set after the wrong span, an
 * error riding the success channel) — absence of data looks identical to
 * health in production, so these contracts have to be pinned in tests. */

export interface RecordedSpan {
  readonly name: string;
  readonly span: Tracer.NativeSpan;
  /** Attributes as a plain object snapshot (live map — read after run). */
  readonly attributes: ReadonlyMap<string, unknown>;
}

export interface RecordingTracer {
  readonly tracer: Tracer.Tracer;
  readonly spans: readonly RecordedSpan[];
  /** All recorded spans with the given name. */
  readonly byName: (name: string) => readonly RecordedSpan[];
  /** Exactly-one convenience: throws when zero or multiple spans match. */
  readonly single: (name: string) => RecordedSpan;
}

export const makeRecordingTracer = (): RecordingTracer => {
  const spans: RecordedSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push({ name: options.name, span, attributes: span.attributes });
      return span;
    },
  });
  return {
    tracer,
    spans,
    byName: (name) => spans.filter((entry) => entry.name === name),
    single: (name) => {
      const matches = spans.filter((entry) => entry.name === name);
      if (matches.length !== 1) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test helper: a wrong span count is a test bug, fail the test loud
        throw new Error(
          `Expected exactly one "${name}" span, recorded ${matches.length} (all spans: ${spans.map((entry) => entry.name).join(", ")})`,
        );
      }
      return matches[0]!;
    },
  };
};

/** Run an effect with a recording tracer and return both its exit and the
 *  recorded spans. The effect's failure is captured, not thrown — telemetry
 *  contracts usually assert on spans of FAILING operations. */
export const runWithRecordingTracer = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<{
  readonly exit: Exit.Exit<A, E>;
  readonly recording: RecordingTracer;
}> =>
  Effect.suspend(() => {
    const recording = makeRecordingTracer();
    return Effect.exit(effect).pipe(
      Effect.withTracer(recording.tracer),
      Effect.map((exit) => ({ exit, recording })),
    );
  });

/** The span's ended exit, or null while started. */
export const spanExit = (entry: RecordedSpan): Exit.Exit<unknown, unknown> | null => {
  const status = entry.span.status;
  return Predicate.isTagged(status, "Ended") ? status.exit : null;
};

/** True when the span ended with a failure exit (what OTLP exporters map to
 *  status ERROR). */
export const spanEndedWithError = (entry: RecordedSpan): boolean => {
  const exit = spanExit(entry);
  return exit != null && Exit.isFailure(exit);
};
