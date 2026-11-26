import {
  TelemetryDrainScope,
  type TelemetryWait,
  TelemetryWaitReport,
} from "@executor-js/telemetry";
import { isScopeEjected } from "alchemy/Http";
import { Clock, Context, Duration, Effect, Exit, Scope } from "effect";

export const backgroundWait = Duration.seconds(20);

export const nestedWait = Duration.seconds(5);

type Wait = "background" | "nested" | "telemetry";

const reportedWaitMs = 1_000;

export class ServedRequest {
  #closing: number | undefined;
  readonly #waits = new Set<Effect.Effect<void>>();
  readonly #waited: Record<Wait, number> = { background: 0, nested: 0, telemetry: 0 };
  readonly #bounded = new Set<Wait>();
  readonly #telemetryBounded = new Set<TelemetryWait>();

  constructor(
    readonly scope: Scope.Scope,
    readonly object: ObjectRequests | undefined,
  ) {}

  get open() {
    return this.scope.state._tag !== "Closed";
  }

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

  telemetryBound(wait: TelemetryWait): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#bounded.add("telemetry");
      this.#telemetryBounded.add(wait);
    });
  }

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

  start(): Effect.Effect<Scope.Scope> {
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

export class ObjectRequests {
  #requests: Array<ServedRequest> = [];

  serve(scope: Scope.Scope) {
    this.#requests = this.#requests.filter((request) => request.open);
    const request = new ServedRequest(scope, this);
    this.#requests.push(request);
    return request;
  }

  serving() {
    this.#requests = this.#requests.filter((request) => request.open);
    return this.#requests.findLast((request) => !isScopeEjected(request.scope));
  }
}

export const CurrentRequest = Context.Reference<ServedRequest | undefined>(
  "executor/cloud/CurrentRequest",
  { defaultValue: () => undefined },
);

export const ownTelemetryScope = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const request = yield* CurrentRequest;
  return request?.scope === scope ? yield* TelemetryDrainScope : undefined;
});

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

export const servedRequest = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.scope, (scope) => serving(handler)(new ServedRequest(scope, undefined)));

export const objectRequest =
  (object: ObjectRequests) =>
  <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.scope, (scope) => serving(handler)(object.serve(scope)));
