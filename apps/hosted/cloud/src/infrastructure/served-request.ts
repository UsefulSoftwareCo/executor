/**
 * The request a Worker event or Durable Object call serves: the background work its close waits
 * for before the event exports its telemetry, and the order in which its close releases things.
 *
 * Background work runs in the scope it is offered in, beside the resources that scope holds, and
 * that scope's close waits for it (`executor.ts`). Alchemy exports an event's telemetry after the
 * request's scope closes, so work offered in a nested scope, such as an MCP tool call's operation,
 * could end after the export: its spans then waited in the isolate for another event to export
 * them, or were lost with the isolate. The request's close therefore also waits for the work of
 * every nested scope that offered some while it ran, at most `nestedWait`.
 *
 * The request's close waits only while its response is buffered. A streamed response ends when
 * its request's scope has closed, so a wait there would hold the end of the body; that work's
 * spans leave with a later export, as before.
 *
 * A close never waits on a telemetry endpoint while it holds the request's database connections.
 * Telemetry the request waits for when it ends, such as an app runtime's forwarded spans and the
 * analytics batch, belongs to the request's telemetry scope (`TelemetryDrainScope`), which closes
 * after every other finalizer of the request: after its background work, its executor and its
 * event pool. The event's own export runs later still, when Alchemy closes the event's scope.
 *
 * A close that waited a second or more in all, or reached a bound, reports in one log line how long
 * it waited for each kind of work and which waits reached their bound; for a telemetry wait, also
 * which one (the forwarder's drain or the analytics flush). It carries durations and fixed labels
 * only.
 */
import {
  TelemetryDrainScope,
  type TelemetryWait,
  TelemetryWaitReport,
} from "@executor-js/telemetry";
import { isScopeEjected } from "alchemy/Http";
import { Clock, Context, Duration, Effect, Exit, Scope } from "effect";

/**
 * How long a request's close waits for its own background work: tool listings and tool call log
 * writes that run beside the request, which use its database connections. Cloudflare stops an
 * event's work 30 s after its response; this leaves the event's own cleanup and its export the
 * rest, as before.
 */
export const backgroundWait = Duration.seconds(20);

/**
 * How long a request's close waits for the work of nested scopes, within `backgroundWait`. A tool
 * call log write's p99 was 47-424 ms in production before the 12 November stall; during it, closes
 * held at the 20 s bound kept the API Worker's event pool and executor open. A write slower than
 * this is a stall, and its spans leave with a later export, as before this wait existed.
 */
export const nestedWait = Duration.seconds(5);

/** What a close waited for: its own background work, nested scopes' work, or telemetry. */
type Wait = "background" | "nested" | "telemetry";

/**
 * A close is reported when its waits add up to this or one reached its bound. Nearly every request
 * flushes its analytics batch, a round trip of tens of milliseconds, so a lower threshold would
 * report almost every close.
 */
const reportedWaitMs = 1_000;

export class ServedRequest {
  #closing: number | undefined;
  readonly #waits = new Set<Effect.Effect<void>>();
  readonly #waited: Record<Wait, number> = { background: 0, nested: 0, telemetry: 0 };
  readonly #bounded = new Set<Wait>();
  /** Which of the request's telemetry waits reached their bound. */
  readonly #telemetryBounded = new Set<TelemetryWait>();

  constructor(
    readonly scope: Scope.Scope,
    /** The other requests a Durable Object serves at the same time, if any. */
    readonly object: ObjectRequests | undefined,
  ) {}

  get open() {
    return this.scope.state._tag !== "Closed";
  }

  /** Time `wait` as `kind`, and note whether it reached its bound. */
  #timed(kind: Wait, wait: Effect.Effect<boolean>): Effect.Effect<void> {
    return Effect.flatMap(Clock.currentTimeMillis, (started) =>
      wait.pipe(
        Effect.flatMap((finished) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            this.#waited[kind] += now - started;
            if (!finished) this.#bounded.add(kind);
          }),
        ),
      ),
    );
  }

  /**
   * Wait for `drained` as `kind`, until `backgroundWait` after the first of this request's
   * bounded waits began, and at most `most`.
   */
  bounded(
    drained: Effect.Effect<void>,
    kind: Wait,
    most: Duration.Input = backgroundWait,
  ): Effect.Effect<void> {
    return this.#timed(
      kind,
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        this.#closing ??= now;
        const left = Math.min(
          this.#closing + Duration.toMillis(backgroundWait) - now,
          Duration.toMillis(Duration.fromInputUnsafe(most)),
        );
        return left <= 0
          ? Effect.succeed(false)
          : Effect.map(Effect.timeoutOption(drained, left), (done) => done._tag === "Some");
      }),
    );
  }

  /**
   * Make an open request's close wait for a nested scope's `drained` too: this one, or once it
   * has closed, another request its object still serves. A tool call that waited for input
   * across two requests ends while the second is served, so that one exports its work.
   */
  join(drained: Effect.Effect<void>): Effect.Effect<void> {
    return Effect.suspend(() => {
      const request = this.open ? this : this.object?.serving();
      return request === undefined ? Effect.void : request.#wait(drained);
    });
  }

  #wait(drained: Effect.Effect<void>): Effect.Effect<void> {
    if (this.#waits.has(drained)) return Effect.void;
    this.#waits.add(drained);
    if (this.#waits.size > 1) return Effect.void;
    let adding = true;
    return Scope.addFinalizer(
      this.scope,
      Effect.suspend(() =>
        // A scope that closed after `join` found it open runs the finalizer here, as it is
        // added: the offering fiber must not wait, so the request no longer takes waits.
        adding
          ? Effect.sync(() => this.#waits.clear())
          : isScopeEjected(this.scope)
            ? Effect.void
            : this.bounded(
                Effect.forEach([...this.#waits], (wait) => wait, {
                  concurrency: "unbounded",
                  discard: true,
                }),
                "nested",
                nestedWait,
              ),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          adding = false;
        }),
      ),
    );
  }

  /** Record that one of the request's telemetry waits reached its bound. */
  telemetryBound(wait: TelemetryWait): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#bounded.add("telemetry");
      this.#telemetryBounded.add(wait);
    });
  }

  /** One log line for a close that waited. */
  readonly report: Effect.Effect<void> = Effect.suspend(() => {
    const waited = this.#waited;
    if (
      this.#bounded.size === 0 &&
      waited.background + waited.nested + waited.telemetry < reportedWaitMs
    )
      return Effect.void;
    return Effect.logInfo("executor.request.close").pipe(
      Effect.annotateLogs({
        "executor.close.background_ms": waited.background,
        "executor.close.nested_ms": waited.nested,
        "executor.close.telemetry_ms": waited.telemetry,
        "executor.close.bounded": [...this.#bounded].sort().join(","),
        "executor.close.telemetry_bounded": [...this.#telemetryBounded].sort().join(","),
        "executor.close.streamed": isScopeEjected(this.scope),
      }),
    );
  });

  /**
   * Open this request's telemetry scope, which closes after every finalizer the request adds from
   * now on, and report the close after it. Called once, as the request starts.
   */
  start(): Effect.Effect<Scope.Scope> {
    // Its waits do not depend on one another, so they run together: a stalled endpoint holds the
    // close for one bound, not the sum.
    const telemetry = Scope.makeUnsafe("parallel");
    return Scope.addFinalizer(this.scope, this.report).pipe(
      Effect.andThen(
        Scope.addFinalizer(
          this.scope,
          this.#timed("telemetry", Effect.as(Scope.close(telemetry, Exit.void), true)),
        ),
      ),
      Effect.as(telemetry),
    );
  }
}

/** The requests one Durable Object is serving. */
export class ObjectRequests {
  #requests: Array<ServedRequest> = [];

  /** Serve a request in `scope`. */
  serve(scope: Scope.Scope) {
    this.#requests = this.#requests.filter((request) => request.open);
    const request = new ServedRequest(scope, this);
    this.#requests.push(request);
    return request;
  }

  /**
   * The newest request still open whose response is not streamed: a streamed request's close does
   * not wait for background work, so work given to it would not be exported with it.
   */
  serving() {
    this.#requests = this.#requests.filter((request) => request.open);
    return this.#requests.findLast((request) => !isScopeEjected(request.scope));
  }
}

/** The request the current fiber serves; each request entry sets it. */
export const CurrentRequest = Context.Reference<ServedRequest | undefined>(
  "executor/cloud/CurrentRequest",
  { defaultValue: () => undefined },
);

/**
 * The telemetry scope for telemetry built in the current scope: the request's, when the current
 * scope is the request's own; none otherwise. A nested scope, such as an MCP tool call's
 * operation, can outlive its request: a call that pauses for input ends while a later request is
 * served, and telemetry it forwards then must not depend on a scope the first request closed. It
 * stays in the nested scope, whose close waits for it.
 */
export const ownTelemetryScope = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const request = yield* CurrentRequest;
  return request?.scope === scope ? yield* TelemetryDrainScope : undefined;
});

/** Run `handler` as `request`, with its telemetry scope. */
const serving =
  <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  (request: ServedRequest) =>
    Effect.flatMap(request.start(), (telemetry) =>
      handler.pipe(
        Effect.provideService(CurrentRequest, request),
        Effect.provideService(TelemetryDrainScope, telemetry),
        Effect.provideService(TelemetryWaitReport, (wait) => request.telemetryBound(wait)),
      ),
    );

/** Serve `handler` as a request of its own, outside any Durable Object. */
export const servedRequest = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.scope, (scope) => serving(handler)(new ServedRequest(scope, undefined)));

/** Serve `handler` as one of the requests `object` serves. */
export const objectRequest =
  (object: ObjectRequests) =>
  <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.scope, (scope) => serving(handler)(object.serve(scope)));
