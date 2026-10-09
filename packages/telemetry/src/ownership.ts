/**
 * Who a span's work belongs to, and how a measured span's time divides among them. A span that
 * starts work for someone other than its caller declares the owner with `ownedBy`; any other span
 * works for whoever its parent works for. Each instant then belongs to the innermost boundary in
 * progress, so Executor's work inside an upstream session stays Executor's, and an app's callback
 * inside Executor's cache stays the app's.
 *
 * Workers clocks advance only on I/O, so durations are comparable within one isolate and not across
 * isolates: each isolate measures its own part, and the spans that already bracket the work define
 * it, so the accounting and the trace agree.
 */
import { Clock, Context, Effect, type Exit, Option, Tracer } from "effect";

/**
 * Executor's own work; the app's authored code; waiting on an upstream provider; or waiting on a
 * person's answer.
 */
export type Owner = "executor" | "app" | "upstream" | "person";

/** The attribute that shows a boundary's owner in the trace; the telemetry tracer sets it. */
export const ownerAttribute = "executor.owner";

const SpanOwner = Context.Reference<Owner | undefined>("@executor-js/telemetry/SpanOwner", {
  defaultValue: () => undefined,
});

/** The owner a span declared when it started, if it is an ownership boundary. */
export const declaredOwner = (annotations: Context.Context<never>) =>
  Context.get(annotations, SpanOwner);

/**
 * Options for a span whose work belongs to `owner`. Every ownership boundary uses them, at the point
 * the work starts: provider requests and sessions are the upstream's, Executor's services called by
 * an app are Executor's, an app's callbacks are the app's, and waiting for an answer is the person's.
 */
export const ownedBy = (
  owner: Owner,
  options: Tracer.SpanOptionsNoTrace = {},
): Tracer.SpanOptionsNoTrace => ({
  ...options,
  annotations: Context.add(options.annotations ?? Context.empty(), SpanOwner, owner),
});

/** Run `effect` in span `name`, owned by `owner`. */
export const owned =
  (owner: Owner, name: string, options?: Tracer.SpanOptionsNoTrace) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.withSpan(name, ownedBy(owner, options)));

/** What a measured span does with its work and its end. */
export interface SpanMeasure {
  /** Wraps the work inside the span, for example to observe the spans it opens. */
  readonly around?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Receives the span's end, before the span ends, to record what it measured on it. */
  readonly end: (end: bigint, span: Tracer.Span) => void;
}

/**
 * Run `effect` in span `name`, measured by `measure` from the span's own start to its own end, so
 * the span's duration and the measurement share both boundaries.
 */
export const measuredSpan =
  (name: string, options: Tracer.SpanOptionsNoTrace, measure: (start: bigint) => SpanMeasure) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> =>
    Effect.useSpan(name, options, (span) => {
      const inner = Effect.withParentSpan(effect, span);
      // A span that never started, because tracing is off, has no window to measure.
      if (span.status._tag === "Ended") return inner;
      const { around, end } = measure(span.status.startTime);
      return (around === undefined ? inner : around(inner)).pipe(
        Effect.onExit((exit) =>
          Effect.flatMap(Clock.currentTimeNanos, (now) =>
            Effect.sync(() => {
              end(now, span);
              span.end(now, exit);
            }),
          ),
        ),
      );
    });

/** A span in progress: its owner, the span it was opened in, and how many of its children run. */
interface Boundary {
  readonly owner: Owner;
  parent: Boundary | undefined;
  open: boolean;
  children: number;
}

/**
 * When work runs in several branches at once, each instant goes to the first owner here with a
 * branch in progress. Executor's work counts wherever it runs, and a person's answer outweighs the
 * upstream request that waits on it.
 */
const concurrent: readonly Owner[] = ["executor", "person", "upstream", "app"];

/**
 * Divide a window that starts at `origin`, whose own work is `owner`'s, among owners. At each
 * instant, the work in progress is the innermost span of each branch: a span with no child still
 * open. Its owner takes the instant. With nothing open inside the window, `owner` takes it. Spans
 * are counted as they open and end, in constant time each, and only spans still open are kept.
 */
export const makeOwnershipAccounting = (origin: bigint, owner: Owner) => {
  const totals: Record<Owner, number> = { executor: 0, app: 0, upstream: 0, person: 0 };
  // Innermost spans in progress, by owner.
  const innermost: Record<Owner, number> = { executor: 0, app: 0, upstream: 0, person: 0 };
  const boundaries = new WeakMap<Tracer.AnySpan, Boundary>();
  let reached = origin;
  let done = false;
  const advance = (time: bigint) => {
    if (time <= reached) return;
    const current = concurrent.find((candidate) => innermost[candidate] > 0) ?? owner;
    totals[current] += Number(time - reached) / 1_000_000;
    reached = time;
  };
  /** The closest span still open around `boundary`; a span's children outlive it in its parent. */
  const enclosing = (boundary: Boundary) => {
    let found = boundary.parent;
    while (found !== undefined && !found.open) found = found.parent;
    boundary.parent = found;
    return found;
  };
  const opened = (boundary: Boundary) => {
    const parent = enclosing(boundary);
    if (parent !== undefined && parent.children++ === 0) innermost[parent.owner] -= 1;
    innermost[boundary.owner] += 1;
  };
  const closed = (boundary: Boundary) => {
    boundary.open = false;
    if (boundary.children === 0) innermost[boundary.owner] -= 1;
    const parent = enclosing(boundary);
    if (parent === undefined) return;
    parent.children += boundary.children - 1;
    if (parent.children === 0) innermost[parent.owner] += 1;
  };
  const observed = (tracer: Tracer.Tracer): Tracer.Tracer => ({
    ...tracer,
    span: (options) => {
      const span = tracer.span(options);
      if (done) return span;
      const parent = Option.getOrUndefined(options.parent);
      const enclosingBoundary = parent === undefined ? undefined : boundaries.get(parent);
      const boundary: Boundary = {
        owner: declaredOwner(options.annotations) ?? enclosingBoundary?.owner ?? owner,
        parent: enclosingBoundary,
        open: true,
        children: 0,
      };
      advance(options.startTime);
      opened(boundary);
      const tracked: Tracer.Span = {
        _tag: "Span",
        get name() {
          return span.name;
        },
        get spanId() {
          return span.spanId;
        },
        get traceId() {
          return span.traceId;
        },
        get parent() {
          return span.parent;
        },
        get annotations() {
          return span.annotations;
        },
        get status() {
          return span.status;
        },
        get attributes() {
          return span.attributes;
        },
        get links() {
          return span.links;
        },
        get sampled() {
          return span.sampled;
        },
        get kind() {
          return span.kind;
        },
        end: (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
          if (boundary.open && !done) {
            advance(endTime);
            closed(boundary);
          }
          span.end(endTime, exit);
        },
        attribute: (key, value) => span.attribute(key, value),
        event: (name, startTime, attributes) => span.event(name, startTime, attributes),
        addLinks: (links) => span.addLinks(links),
      };
      boundaries.set(tracked, boundary);
      return tracked;
    },
  });
  return {
    /** Run `effect` with the spans it opens observed, including spans it hands to later work. */
    observe: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        return yield* effect.pipe(Effect.provideService(Tracer.Tracer, observed(tracer)));
      }),
    /**
     * Close the window at `end` and return its milliseconds by owner, each instant counted once.
     * Spans still open count up to `end`; spans that open or end afterwards are ignored.
     */
    read: (end: bigint): Readonly<Record<Owner, number>> => {
      if (!done) advance(end);
      done = true;
      return totals;
    },
  };
};
