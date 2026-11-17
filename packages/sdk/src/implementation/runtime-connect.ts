/**
 * One repeat of an exchange with the local app runtime (workerd) whose connection never formed, so
 * nothing of it left the host. On Windows, Bun (and libuv) connect to a loopback address with one
 * SYN and no retransmission, so a SYN-ACK slower than about a quarter of a second fails the connect
 * with `ETIMEDOUT` while the runtime is healthy. Repeating such an exchange cannot repeat any work:
 * none was sent. Anything that may have reached the runtime is never repeated.
 *
 * Each repeat re-runs the exchange from its own first statement, so whatever the exchange checks
 * before it connects is checked again before the second connect.
 *
 * What the span records: the plain hop attributes (`executor.runtime.rpc.*`, `.http.*`) describe
 * the attempt that decided the outcome. A repeated exchange adds `connect_attempts` (2),
 * `connect_outcome` (`opened`, `answered` or `failed`) and the first attempt's facts under
 * `first_attempt.` (`error_code`, `failed_ms`). The first attempt's own hop attributes are held
 * while it runs, and reach the span unchanged only when it is not repeated.
 */
import { Cause, Data, Deferred, Effect, Exit, Predicate, type Scope } from "effect";
import { RuntimeProtocolFailed } from "../contracts/runtime.ts";
import {
  annotateChecked,
  codeOf,
  HopRecording,
  platformError,
  type HopAttributes,
} from "./runtime-hop.ts";

/** An RPC session whose WebSocket closed or failed before it opened: nothing was sent on it. */
export class SocketNeverOpened extends Data.TaggedError("SocketNeverOpened")<{
  readonly code: string | undefined;
  readonly failedMs: number;
}> {}

/** The minimal view of a `ws` client socket that tells whether it opened. */
interface OpeningSocket {
  once(event: "open" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Whether one RPC session's socket opens. `watch` is called with the socket as soon as it is made,
 * before anything can be sent on it; `opened` succeeds once it opens, or fails with
 * `SocketNeverOpened` when it closes or errors first. `neverOpened` is that fact, read from the
 * socket itself: the repeat is decided from it, not from whichever error the session ends with.
 */
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

/** Run `attempt` with its hop attributes held rather than written, returning both. */
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

/** The span attributes of a repeated connect: the first attempt's failure and how the repeat ended. */
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

/**
 * The failure of an RPC exchange whose socket never opened, twice: the runtime was not reached.
 * Its reason is `disconnected`, the value clients already know for a lost connection; `notSent`
 * says nothing was sent, and older clients drop it.
 */
const unreachable = Effect.annotateCurrentSpan({
  "executor.runtime.failure": "unreachable",
  "executor.runtime.cause": "Executor could not connect to the app runtime",
}).pipe(
  Effect.andThen(Effect.fail(new RuntimeProtocolFailed({ reason: "disconnected", notSent: true }))),
);

/**
 * Run an RPC exchange, `attempt`, which waits for its socket to open before it sends anything. When
 * its socket never opened, run it once more, from its start, at once. When that socket never opens
 * either, fail as `unreachable` with `notSent`. Whether to repeat is read from the socket's own
 * state (`Opening.neverOpened`), so it holds whatever error the attempt ends with. A failure after
 * the socket opened is the exchange's own and is never repeated.
 */
export const repeatUnopened = <A, E, R, E2 = never, R2 = never>(
  attempt: (opening: Opening) => Effect.Effect<A, E, R>,
  options: {
    /**
     * Runs before every connect, the repeat's included: the place for a check that must hold
     * before the host connects at all, such as whether it has given the runtime up.
     */
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
      // A reason the session chose for itself, other than a lost connection, is kept; only the
      // fact that nothing was sent is added.
      const own = Exit.findErrorOption(second);
      return yield* own._tag === "Some" &&
      own.value instanceof RuntimeProtocolFailed &&
      own.value.reason !== undefined &&
      own.value.reason !== "disconnected"
        ? Effect.fail(new RuntimeProtocolFailed({ reason: own.value.reason, notSent: true }))
        : unreachable;
    }
    return yield* second;
    // An attempt fails with `SocketNeverOpened` only when its socket never opened, and then the
    // second attempt's failure is replaced above: it never reaches the caller.
  }) as Effect.Effect<A, Exclude<E, SocketNeverOpened> | E2 | RuntimeProtocolFailed, R | R2>;

/**
 * Whether an HTTP exchange's failure is provably its connect failing, so that no byte of the request
 * was written. Only facts the platform sets on its error are read, never its text:
 *
 * - Node (undici over `node:net`): the socket error's `syscall` is `connect`, or undici's own connect
 *   time-out (`UND_ERR_CONNECT_TIMEOUT`). Both come before the request is written.
 * - Bun: `fetch` reports `ECONNREFUSED` only for a connect that failed (`on_connect_error` in its
 *   HTTP client; a closed connection is `ECONNRESET`). Its connect time-out on Windows is
 *   `ETIMEDOUT`, but so is its socket idle time-out after the request was written, and nothing on
 *   the error tells them apart, so a Bun `ETIMEDOUT` is not repeated.
 */
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

/**
 * Run an HTTP exchange and, when it fails at connect (`failedAtConnect`), run it once more from its
 * start, at once. Any other failure, and the repeat's own, is the exchange's.
 */
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

/**
 * An HTTP exchange in its own scope, repeated once from its start when it fails at connect
 * (`repeatAtConnect`). Each attempt has a scope of its own.
 */
export const repeatingAtConnect = <A, E, R>(
  exchange: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> => repeatAtConnect(Effect.scoped(exchange));
