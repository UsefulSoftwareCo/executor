import { Cause, Data, Deferred, Effect, Exit, Predicate, type Scope } from "effect";
import { RuntimeProtocolFailed } from "../contracts/runtime.ts";
import {
  annotateChecked,
  codeOf,
  HopRecording,
  platformError,
  type HopAttributes,
} from "./runtime-hop.ts";

export class SocketNeverOpened extends Data.TaggedError("SocketNeverOpened")<{
  readonly code: string | undefined;
  readonly failedMs: number;
}> {}

interface OpeningSocket {
  once(event: "open" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
}

export interface Opening {
  readonly watch: (socket: OpeningSocket) => void;
  readonly opened: Effect.Effect<void, SocketNeverOpened>;
  readonly neverOpened: () => SocketNeverOpened | undefined;
}

const opening = Effect.gen(function* () {
  const outcome = yield* Deferred.make<void, SocketNeverOpened>();
  let never: SocketNeverOpened | undefined;
  return {
    watch: (socket: OpeningSocket) => {
      const created = performance.now();
      let opened = false;
      let code: string | undefined;
      socket.once("open", () => {
        opened = true;
        Deferred.doneUnsafe(outcome, Effect.void);
      });
      socket.once("error", (error) => {
        code = Predicate.hasProperty(error, "code") ? codeOf(error.code) : undefined;
      });
      socket.once("close", () => {
        if (opened) return;
        never = new SocketNeverOpened({ code, failedMs: Math.round(performance.now() - created) });
        Deferred.doneUnsafe(outcome, Effect.fail(never));
      });
    },
    opened: Deferred.await(outcome),
    neverOpened: () => never,
  } satisfies Opening;
});

const interrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

const held = <A, E, R>(attempt: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const attributes: Record<string, string | number | boolean> = {};
    const exit = yield* Effect.exit(
      attempt.pipe(
        Effect.provideService(HopRecording, (recorded: HopAttributes) => {
          Object.assign(attributes, recorded);
        }),
      ),
    );
    return { exit, attributes };
  });

const repeated = (
  prefix: "rpc" | "http",
  first: { readonly code: string | undefined; readonly failedMs: number },
  outcome: "opened" | "answered" | "failed",
) =>
  annotateChecked({
    [`executor.runtime.${prefix}.connect_attempts`]: 2,
    [`executor.runtime.${prefix}.connect_outcome`]: outcome,
    [`executor.runtime.${prefix}.first_attempt.error_code`]: first.code ?? "none",
    [`executor.runtime.${prefix}.first_attempt.failed_ms`]: first.failedMs,
  });

const unreachable = Effect.annotateCurrentSpan({
  "executor.runtime.failure": "unreachable",
  "executor.runtime.cause": "Executor could not connect to the app runtime",
}).pipe(
  Effect.andThen(Effect.fail(new RuntimeProtocolFailed({ reason: "disconnected", notSent: true }))),
);

export const repeatUnopened = <A, E, R, E2 = never, R2 = never>(
  attempt: (opening: Opening) => Effect.Effect<A, E, R>,
  options: {
    readonly beforeEachConnect?: Effect.Effect<void, E2, R2>;
  } = {},
): Effect.Effect<A, Exclude<E, SocketNeverOpened> | E2 | RuntimeProtocolFailed, R | R2> =>
  Effect.gen(function* () {
    const before = options.beforeEachConnect ?? Effect.void;
    yield* before;
    const firstOpening = yield* opening;
    const first = yield* held(attempt(firstOpening));
    const never = firstOpening.neverOpened();
    if (never === undefined || interrupted(first.exit)) {
      yield* Effect.annotateCurrentSpan(first.attributes);
      return yield* first.exit;
    }
    yield* before;
    const secondOpening = yield* opening;
    const second = yield* Effect.exit(attempt(secondOpening));
    const unopened = secondOpening.neverOpened() !== undefined;
    yield* repeated("rpc", never, unopened ? "failed" : "opened");
    if (unopened && Exit.isFailure(second) && !interrupted(second)) {
      const own = Exit.findErrorOption(second);
      return yield* own._tag === "Some" &&
      own.value instanceof RuntimeProtocolFailed &&
      own.value.reason !== undefined &&
      own.value.reason !== "disconnected"
        ? Effect.fail(new RuntimeProtocolFailed({ reason: own.value.reason, notSent: true }))
        : unreachable;
    }
    return yield* second;
  }) as Effect.Effect<A, Exclude<E, SocketNeverOpened> | E2 | RuntimeProtocolFailed, R | R2>;

export const failedAtConnect = (error: unknown): boolean => {
  if (!Predicate.hasProperty(error, "_tag") || error._tag !== "HttpClientError") return false;
  if (!Predicate.hasProperty(error, "reason") || !Predicate.hasProperty(error.reason, "_tag"))
    return false;
  if (error.reason._tag !== "TransportError") return false;
  const platform = platformError(error);
  if (!Predicate.isObject(platform)) return false;
  const syscall = Predicate.hasProperty(platform, "syscall") ? platform.syscall : undefined;
  const code = Predicate.hasProperty(platform, "code") ? platform.code : undefined;
  return syscall === "connect" || code === "ECONNREFUSED" || code === "UND_ERR_CONNECT_TIMEOUT";
};

export const repeatAtConnect = <A, E, R>(
  exchange: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const started = performance.now();
    const first = yield* held(exchange);
    const error = Exit.isFailure(first.exit) ? Exit.findErrorOption(first.exit) : undefined;
    if (error === undefined || error._tag === "None" || !failedAtConnect(error.value)) {
      yield* Effect.annotateCurrentSpan(first.attributes);
      return yield* first.exit;
    }
    const platform = platformError(error.value);
    const firstFacts = {
      code: Predicate.hasProperty(platform, "code") ? codeOf(platform.code) : undefined,
      failedMs: Math.round(performance.now() - started),
    };
    const second = yield* Effect.exit(exchange);
    yield* repeated("http", firstFacts, Exit.isSuccess(second) ? "answered" : "failed");
    return yield* second;
  });

export const repeatingAtConnect = <A, E, R>(
  exchange: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> => repeatAtConnect(Effect.scoped(exchange));
