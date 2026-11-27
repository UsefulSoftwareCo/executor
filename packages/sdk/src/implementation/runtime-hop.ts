import { Cause, Context, Effect, Predicate } from "effect";

export type HopAttributes = Readonly<Record<string, string | number | boolean>>;

export interface RuntimeView {
  readonly restarts: () => { readonly count: number; readonly lastAt: number | undefined };
  readonly probe: () => unknown;
}
const noRuntimeView: RuntimeView = {
  restarts: () => ({ count: 0, lastAt: undefined }),
  probe: () => ({}),
};

const recordingFailed: HopAttributes = { "executor.runtime.recording": "failed" };

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

const codeForm = /^(?:[A-Z][A-Z0-9_]{1,39}|(?:[A-Z][a-z]{1,15}){1,5})$/;
const syscallForm = /^[a-z]{2,16}$/;
const tagForm = /^[A-Z][A-Za-z0-9]{1,39}$/;
const valueForm = /^(?:[A-Za-z][A-Za-z0-9_-]{0,39}|\/[a-z]{1,23})$/;
const probeValueForm = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const keyForm = /^executor\.runtime\.[a-z_]+(?:\.[a-z_]+){0,2}$/;
const probeKeyForm = /^executor\.runtime\.probe\.[a-z_]+(?:\.[a-z_]+)?$/;

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

const guarded = (build: () => HopAttributes): HopAttributes => {
  try {
    return build();
  } catch {
    return recordingFailed;
  }
};
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

export const annotateChecked = (attributes: Record<string, unknown>) =>
  annotate(() => checked(attributes));
export const errorClassOf = (error: unknown): string =>
  error instanceof Error && standardErrorNames.has(error.name) ? error.name : "other";
export const codeOf = (value: unknown): string => {
  const code = shape(value, codeForm);
  return typeof code === "string" ? code : "other";
};

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

type HttpStage = "request" | "status" | "response-body";

interface TrackedSocket {
  on(event: "open" | "message", listener: () => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  send: (...args: never[]) => unknown;
}

export interface SocketRecord {
  readonly ended: () => boolean;
  readonly attributes: () => Record<string, unknown>;
}

const lostConnection = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      Predicate.hasProperty(reason.error, "_tag") &&
      reason.error._tag === "RuntimeProtocolFailed" &&
      Predicate.hasProperty(reason.error, "reason") &&
      reason.error.reason === "disconnected",
  );

export const runtimeHops = (view: RuntimeView = noRuntimeView) => {
  let lastHttpEnded: number | undefined;

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
