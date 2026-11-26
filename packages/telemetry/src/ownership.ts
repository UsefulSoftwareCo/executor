import { Clock, Context, Effect, type Exit, Option, Tracer } from "effect";

export type Owner = "executor" | "app" | "upstream" | "person" | "lease" | "background";

export const ownerAttribute = "executor.owner";

const SpanOwner = Context.Reference<Owner | undefined>("@executor-js/telemetry/SpanOwner", {
  defaultValue: () => undefined,
});

export const declaredOwner = (annotations: Context.Context<never>) =>
  Context.get(annotations, SpanOwner);

export const ownedBy = (
  owner: Owner,
  options: Tracer.SpanOptionsNoTrace = {},
): Tracer.SpanOptionsNoTrace => ({
  ...options,
  annotations: Context.add(options.annotations ?? Context.empty(), SpanOwner, owner),
});

export const owned =
  (owner: Owner, name: string, options?: Tracer.SpanOptionsNoTrace) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.withSpan(name, ownedBy(owner, options)));

export interface SpanMeasure {
  readonly around?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly end: (end: bigint, span: Tracer.Span) => void;
}

export const measuredSpan =
  (name: string, options: Tracer.SpanOptionsNoTrace, measure: (start: bigint) => SpanMeasure) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> =>
    Effect.useSpan(name, options, (span) => {
      const inner = Effect.withParentSpan(effect, span);
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

interface Boundary {
  readonly owner: Owner;
  parent: Boundary | undefined;
  open: boolean;
  children: number;
}

const concurrent: readonly Owner[] = ["executor", "person", "upstream", "lease", "app"];

const noTime = (): Record<Owner, number> => ({
  executor: 0,
  app: 0,
  upstream: 0,
  person: 0,
  lease: 0,
  background: 0,
});

export const makeOwnershipAccounting = (origin: bigint, owner: Owner) => {
  const totals = noTime();
  const innermost = noTime();
  const boundaries = new WeakMap<Tracer.AnySpan, Boundary>();
  let reached = origin;
  let done = false;
  let background = 0;
  const advance = (time: bigint) => {
    if (time <= reached) return;
    const current = concurrent.find((candidate) => innermost[candidate] > 0) ?? owner;
    const elapsed = Number(time - reached) / 1_000_000;
    totals[current] += elapsed;
    if (background > 0) totals.background += elapsed;
    reached = time;
  };
  const enclosing = (boundary: Boundary) => {
    let found = boundary.parent;
    while (found !== undefined && !found.open) found = found.parent;
    boundary.parent = found;
    return found;
  };
  const opened = (boundary: Boundary) => {
    if (boundary.owner === "background") {
      background += 1;
      return;
    }
    const parent = enclosing(boundary);
    if (parent !== undefined && parent.children++ === 0) innermost[parent.owner] -= 1;
    innermost[boundary.owner] += 1;
  };
  const closed = (boundary: Boundary) => {
    boundary.open = false;
    if (boundary.owner === "background") {
      background -= 1;
      return;
    }
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
      const inBackground = enclosingBoundary?.owner === "background";
      const declared = inBackground ? "background" : declaredOwner(options.annotations);
      const boundary: Boundary = {
        owner: declared ?? enclosingBoundary?.owner ?? owner,
        parent: declared === "background" ? undefined : enclosingBoundary,
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
    observe: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        return yield* effect.pipe(Effect.provideService(Tracer.Tracer, observed(tracer)));
      }),
    read: (end: bigint): Readonly<Record<Owner, number>> => {
      if (!done) advance(end);
      done = true;
      return totals;
    },
  };
};
