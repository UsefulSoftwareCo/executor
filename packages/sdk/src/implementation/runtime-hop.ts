/**
 * How far an exchange with the local app runtime (workerd) got before it failed, recorded on the
 * current span so a failed call can be told apart: a reply lost as its connection ended, a runtime
 * that never answered, a session that never opened or closed before or after it carried anything,
 * and a runtime that was just replaced. Only measurement: nothing here sends, waits, retries or
 * changes an outcome, and nothing here can change a failure. Every attribute is built inside a
 * guard; if building them throws, the span records one fixed marker and the failure passes on as
 * the same object.
 *
 * Only shapes are recorded, and every value passes one check before it reaches the span: a fixed
 * route and method, error tags, a platform error's standard class name, its `code` and `syscall`
 * when they have the shape a platform gives them, its `errno`, a WebSocket close code, whether a
 * close reason was given, message counts, times and the runtime's restart count. No message text,
 * URL beyond the route's fixed path, header or payload is recorded, so none of an app's or a
 * customer's data can reach telemetry through these attributes.
 */
import { Cause, Context, Effect, Predicate } from "effect";

/** Span attribute values a recording carries: shapes only. */
export type HopAttributes = Readonly<Record<string, string | number | boolean>>;

/**
 * The host's view of its runtime at the moment an exchange fails, recorded beside the exchange's
 * own attributes. `probe` is a supervisor's recent probe events: only keys under
 * `executor.runtime.probe.` with a number, a boolean or a short word as their value are kept.
 */
export interface RuntimeView {
  /** How many times the runtime was replaced, and when the last replacement finished. */
  readonly restarts: () => { readonly count: number; readonly lastAt: number | undefined };
  readonly probe: () => unknown;
}
const noRuntimeView: RuntimeView = {
  restarts: () => ({ count: 0, lastAt: undefined }),
  probe: () => ({}),
};

/** What the span records when building the attributes threw: nothing else. */
const recordingFailed: HopAttributes = { "executor.runtime.recording": "failed" };

/** Error class names the platform and the language define. Any other name is recorded as `other`. */
const standardErrorNames: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "RequestAbortedError",
  "DOMException",
]);

/**
 * A platform error code: Node's and libuv's upper-case codes (`ECONNRESET`, `UND_ERR_SOCKET`,
 * `ERR_STREAM_PREMATURE_CLOSE`), or Bun's words (`ConnectionRefused`, `FailedToOpenSocket`).
 */
const codeForm = /^(?:[A-Z][A-Z0-9_]{1,39}|(?:[A-Z][a-z]{1,15}){1,5})$/;
/** A system call: one short lower-case word (`connect`, `read`, `write`, `getaddrinfo`). */
const syscallForm = /^[a-z]{2,16}$/;
/** An error's `_tag`: one word in upper camel case (`HttpClientError`, `TransportError`). */
const tagForm = /^[A-Z][A-Za-z0-9]{1,39}$/;
/**
 * A value of the recording's own: a word of up to 40 characters, as long as the longest code or tag
 * the forms above accept (Node's and undici's codes run to about 30), or the fixed route.
 */
const valueForm = /^(?:[A-Za-z][A-Za-z0-9_-]{0,39}|\/[a-z]{1,23})$/;
/** A value of a supervisor's probe: a word of up to 24 characters. */
const probeValueForm = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
/** Every key the recording writes. */
const keyForm = /^executor\.runtime\.[a-z_]+(?:\.[a-z_]+){0,2}$/;
/** The only keys a supervisor's probe context may write. */
const probeKeyForm = /^executor\.runtime\.probe\.[a-z_]+(?:\.[a-z_]+)?$/;

/** `value` if it is a bounded finite number, a boolean or a string `form` accepts. */
const shape = (value: unknown, form: RegExp): string | number | boolean | undefined =>
  typeof value === "boolean"
    ? value
    : typeof value === "number"
      ? Number.isFinite(value) && Math.abs(value) < 1e9
        ? value
        : undefined
      : typeof value === "string" && form.test(value)
        ? value
        : undefined;

/**
 * Only well-formed keys with well-formed values: the check every recorded attribute passes. A
 * string of the recording's own that fails it is recorded as `other`, so a reader knows a value was
 * there; a probe's is dropped. Numbers out of range and other values are dropped.
 */
const checked = (attributes: Record<string, unknown>, probe = false): HopAttributes => {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!(probe ? probeKeyForm : keyForm).test(key)) continue;
    const checkedValue = shape(value, probe ? probeValueForm : valueForm);
    if (checkedValue !== undefined) kept[key] = checkedValue;
    else if (typeof value === "string" && !probe) kept[key] = "other";
  }
  return kept;
};

/** The recording's attributes, or the fixed marker if building them threw. */
const guarded = (build: () => HopAttributes): HopAttributes => {
  try {
    return build();
  } catch {
    return recordingFailed;
  }
};
/**
 * Where a hop's attributes go instead of the current span, while an attempt that may be repeated
 * runs (`runtime-connect.ts`). Unset, they go on the span. Attributes about an exchange's attempt
 * belong in `annotateChecked` (or the hops' own recording), which honours it: written to the span
 * directly, a first attempt's attributes would stay on a span the repeat rescued.
 */
export const HopRecording = Context.Reference<((attributes: HopAttributes) => void) | undefined>(
  "executor/HopRecording",
  { defaultValue: () => undefined },
);
const annotate = (build: () => HopAttributes) =>
  Effect.flatMap(HopRecording, (hold) =>
    Effect.suspend(() =>
      hold === undefined
        ? Effect.annotateCurrentSpan(guarded(build))
        : Effect.sync(() => hold(guarded(build))),
    ),
  );

/** Attributes of the recording's own, checked and guarded, on the current span (`runtime-connect.ts`). */
export const annotateChecked = (attributes: Record<string, unknown>) =>
  annotate(() => checked(attributes));
/** A platform error code in one of a platform's forms, otherwise `other`. */
export const codeOf = (value: unknown): string => {
  const code = shape(value, codeForm);
  return typeof code === "string" ? code : "other";
};

/** The runtime's restarts and a supervisor's probe events, each checked; a throwing probe is marked. */
const hostAttributes = (view: RuntimeView, now: number): HopAttributes => {
  const { count, lastAt } = view.restarts();
  let probe: HopAttributes;
  try {
    const value = view.probe();
    probe = Predicate.isObject(value) ? checked(value as Record<string, unknown>, true) : {};
  } catch {
    probe = { "executor.runtime.probe.recording": "failed" };
  }
  return {
    ...probe,
    ...checked({
      "executor.runtime.host.restarts": count,
      "executor.runtime.host.restarted_ms":
        lastAt === undefined ? undefined : Math.round(now - lastAt),
    }),
  };
};

const tagOf = (value: unknown) => {
  const tag = Predicate.hasProperty(value, "_tag") ? value._tag : undefined;
  return typeof tag === "string" ? (tagForm.test(tag) ? tag : "other") : undefined;
};

/**
 * The innermost platform error under an Effect HTTP client error: its reason's cause, followed
 * through `cause` links (an undici `TypeError: fetch failed` carries the socket's error as its cause).
 */
export const platformError = (error: unknown): unknown => {
  let current: unknown =
    Predicate.hasProperty(error, "reason") && Predicate.hasProperty(error.reason, "cause")
      ? error.reason.cause
      : error;
  for (let depth = 0; depth < 4; depth++) {
    if (!Predicate.hasProperty(current, "cause") || current.cause === undefined) break;
    if (Predicate.hasProperty(current, "code") && typeof current.code === "string") break;
    current = current.cause;
  }
  return current;
};

/** A platform error's shape: its standard class name, `code`, `errno` and `syscall`. */
const platformShape = (prefix: string, error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return {};
  const code = Predicate.hasProperty(error, "code") ? error.code : undefined;
  const errno = Predicate.hasProperty(error, "errno") ? error.errno : undefined;
  const syscall = Predicate.hasProperty(error, "syscall") ? error.syscall : undefined;
  return {
    [`${prefix}.error_name`]: standardErrorNames.has(error.name) ? error.name : "other",
    ...(code === undefined ? {} : { [`${prefix}.code`]: shape(code, codeForm) ?? "other" }),
    ...(typeof errno === "number" && Number.isInteger(errno) ? { [`${prefix}.errno`]: errno } : {}),
    ...(syscall === undefined
      ? {}
      : { [`${prefix}.syscall`]: shape(syscall, syscallForm) ?? "other" }),
  };
};

/** The stage an HTTP exchange with the runtime failed at. */
type HttpStage = "request" | "status" | "response-body";

/** A minimal view of a `ws` client socket: the events and method the tracker reads. */
interface TrackedSocket {
  on(event: "open" | "message", listener: () => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  send: (...args: never[]) => unknown;
}

/** What one RPC session's socket did, as far as its shape goes. */
export interface SocketRecord {
  /** Whether the socket has closed or reported an error: a transport failure. */
  readonly ended: () => boolean;
  /** The span attributes describing the socket, measured from its creation to now. */
  readonly attributes: () => Record<string, unknown>;
}

/** Whether a failure is the host's own "the connection to the runtime was lost". */
const lostConnection = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      Predicate.hasProperty(reason.error, "_tag") &&
      reason.error._tag === "RuntimeProtocolFailed" &&
      Predicate.hasProperty(reason.error, "reason") &&
      reason.error.reason === "disconnected",
  );

/** The recording for one runtime: its HTTP routes, its RPC sessions, and its view of itself. */
export const runtimeHops = (view: RuntimeView = noRuntimeView) => {
  /** When the last HTTP exchange with this runtime ended, to say how long its origin was idle. */
  let lastHttpEnded: number | undefined;

  /**
   * Run one HTTP exchange with the runtime and, when it fails, record how far it got: `route`,
   * `method`, the `stage` (`request`: no response headers arrived; `status`: headers arrived with
   * an unexpected status; `response-body`: headers arrived and reading the body failed), the time
   * to failure and to the headers, how long the origin had been idle since the previous exchange
   * ended, the status, the error tags and the platform error's shape. `send` sends the request;
   * `read` checks and reads the response it returns.
   *
   * A fetch client does not report when its connection opened, whether it reused a pooled one, or
   * when its request was fully written, so those cannot be told apart here: a failure before any
   * response headers is `request`, the platform error's code says what the socket saw (Bun retries
   * a reused connection's reset only for GET, so a POST reports it as `ECONNRESET`), and `idle_ms`
   * says whether a pooled connection could have outlived the runtime's 5-second idle limit.
   */
  const http = <R extends { readonly status: number }, A, E1, E2, X1, X2>(
    route: "/workflow" | "/evaluated",
    send: Effect.Effect<R, E1, X1>,
    read: (response: R) => Effect.Effect<A, E2, X2>,
  ): Effect.Effect<A, E1 | E2, X1 | X2> =>
    Effect.suspend(() => {
      const started = performance.now();
      const idleMs = lastHttpEnded === undefined ? undefined : started - lastHttpEnded;
      let headersMs: number | undefined;
      let status: number | undefined;
      const record = (stage: HttpStage, error: unknown) =>
        annotate(() => {
          const now = performance.now();
          return {
            ...hostAttributes(view, now),
            ...checked({
              "executor.runtime.http.route": route,
              // Every runtime hop is a POST: the method a reused connection's reset is not retried for.
              "executor.runtime.http.method": "POST",
              "executor.runtime.http.stage": stage,
              "executor.runtime.http.failed_ms": Math.round(now - started),
              "executor.runtime.http.idle_ms":
                idleMs === undefined ? undefined : Math.round(idleMs),
              "executor.runtime.http.headers_ms": headersMs,
              "executor.runtime.http.status": status,
              "executor.runtime.http.error": tagOf(error),
              "executor.runtime.http.reason": Predicate.hasProperty(error, "reason")
                ? tagOf(error.reason)
                : undefined,
              ...platformShape("executor.runtime.http", platformError(error)),
            }),
          };
        });
      return send.pipe(
        Effect.tapError((error) => record("request", error)),
        Effect.flatMap((response) => {
          headersMs = Math.round(performance.now() - started);
          status = response.status;
          return read(response).pipe(
            Effect.tapError((error) =>
              record(response.status === 200 ? "response-body" : "status", error),
            ),
          );
        }),
        Effect.ensuring(
          Effect.sync(() => {
            lastHttpEnded = performance.now();
          }),
        ),
      );
    });

  /**
   * Watch an RPC session's WebSocket: whether it opened and when, when it closed and with which
   * code, whether a close reason was given (never its text), the code of any `error` event, how
   * many messages were sent (attempts: each call to `send`) and received, and when the last one
   * arrived. Listening and counting only: the socket's `send` is wrapped to count and otherwise
   * called unchanged, and no listener throws.
   */
  const track = (socket: TrackedSocket): SocketRecord => {
    const created = performance.now();
    let openedAt: number | undefined;
    let closedAt: number | undefined;
    let lastReceivedAt: number | undefined;
    let closeCode: unknown;
    let closeReason: "none" | "other" | undefined;
    let errorCode: string | undefined;
    let sent = 0;
    let received = 0;
    socket.on("open", () => {
      openedAt = performance.now();
    });
    socket.on("message", () => {
      received++;
      lastReceivedAt = performance.now();
    });
    socket.on("close", (code, reason) => {
      closedAt = performance.now();
      closeCode = code;
      try {
        closeReason =
          reason === undefined || reason === null || String(reason) === "" ? "none" : "other";
      } catch {
        closeReason = "other";
      }
    });
    socket.on("error", (error) => {
      try {
        const code = Predicate.hasProperty(error, "code") ? error.code : undefined;
        errorCode = code === undefined ? "none" : String(shape(code, codeForm) ?? "other");
      } catch {
        errorCode = "other";
      }
    });
    const send = socket.send.bind(socket) as (...args: never[]) => unknown;
    socket.send = (...args: never[]) => {
      sent++;
      return send(...args);
    };
    return {
      ended: () => closedAt !== undefined || errorCode !== undefined,
      attributes: () => {
        const now = performance.now();
        return {
          "executor.runtime.rpc.opened": openedAt !== undefined,
          "executor.runtime.rpc.open_ms":
            openedAt === undefined ? undefined : Math.round(openedAt - created),
          "executor.runtime.rpc.closed_ms":
            closedAt === undefined ? undefined : Math.round(closedAt - created),
          "executor.runtime.rpc.failed_ms": Math.round(now - created),
          "executor.runtime.rpc.last_received_ms":
            lastReceivedAt === undefined ? undefined : Math.round(now - lastReceivedAt),
          "executor.runtime.rpc.close_code": closeCode,
          "executor.runtime.rpc.close_reason": closeReason,
          "executor.runtime.rpc.error_code": errorCode,
          "executor.runtime.rpc.sent": sent,
          "executor.runtime.rpc.received": received,
        };
      },
    };
  };

  /**
   * Run `work` on an RPC session and, when it fails because the transport did (the socket closed or
   * errored, or the host reports the connection lost), record the socket's shape. An app's own
   * failure on a healthy session, a success and an interruption record nothing.
   */
  const rpc = <A, E, R>(
    socket: () => SocketRecord | undefined,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    work.pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        const record = socket();
        if (record === undefined) return Effect.void;
        let transport: boolean;
        try {
          transport = record.ended() || lostConnection(cause);
        } catch {
          transport = false;
        }
        if (!transport) return Effect.void;
        return annotate(() => ({
          ...hostAttributes(view, performance.now()),
          ...checked(record.attributes()),
        }));
      }),
    );

  return { http, track, rpc };
};
