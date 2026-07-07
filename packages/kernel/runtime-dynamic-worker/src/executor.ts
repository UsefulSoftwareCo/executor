/**
 * DynamicWorkerExecutor — runs sandboxed code in an isolated Cloudflare
 * Worker via the WorkerLoader binding.
 *
 * Tool calls are dispatched over Workers RPC: the host creates a
 * `ToolDispatcher` (an `RpcTarget`) that bridges back to the
 * `SandboxToolInvoker` from codemode-core, and passes it to the
 * dynamic worker's `evaluate()` entrypoint.
 */

import { RpcTarget } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  CodeCompilationError,
  recoverExecutionBody,
  SandboxHostTimeoutError,
  SandboxRuntimeError,
  stripTypeScript,
  type CodeExecutor,
  type ExecuteOutputItem,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor-js/codemode-core";

import { buildExecutorModule } from "./module-template";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DynamicWorkerExecutionError extends Data.TaggedError("DynamicWorkerExecutionError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DynamicWorkerExecutorOptions = {
  readonly loader: WorkerLoader;
  /**
   * Timeout in milliseconds for code execution. Defaults to 5 minutes.
   */
  readonly timeoutMs?: number;
  /**
   * Extra wall-clock the host waits beyond `timeoutMs` before declaring the
   * isolate wedged and delivering a `SandboxHostTimeoutError`. Defaults to 30s.
   * The in-sandbox timer should always fire first for a healthy isolate; this
   * margin only covers the case where that timer is defeated by a wedged RPC.
   * Exposed primarily so tests can shrink the backstop; production leaves it
   * unset.
   */
  readonly hostTimeoutGraceMs?: number;
  /**
   * Poll interval for the host-timeout watchdog, in milliseconds. Defaults to
   * 1s. Exposed for tests; production leaves it unset.
   */
  readonly hostTimeoutPollMs?: number;
  /**
   * Controls outbound network access from sandboxed code.
   * - `null` (default): `fetch()` and `connect()` throw — fully isolated.
   * - `undefined`: inherits parent Worker's network access.
   * - A `Fetcher`: all outbound requests route through this handler.
   */
  readonly globalOutbound?: Fetcher | null;
  /**
   * Additional modules to make available in the sandbox.
   * Keys are module specifiers, values are module source code.
   * The key `"executor.js"` is reserved.
   */
  readonly modules?: Record<string, string>;
};

export type SerializedWorkerErrorValue = unknown;

export type SerializedWorkerError = {
  readonly kind: "fail" | "die" | "interrupt" | "mixed" | "unknown";
  readonly message: string;
  readonly primary: SerializedWorkerErrorValue | null;
  readonly failures: ReadonlyArray<SerializedWorkerErrorValue>;
  readonly defects: ReadonlyArray<SerializedWorkerErrorValue>;
  readonly interrupted: boolean;
};

type WorkerRpcSuccess = {
  readonly ok: true;
  readonly result: unknown;
};

type WorkerRpcFailure = {
  readonly ok: false;
  readonly error: SerializedWorkerError;
};

type WorkerRpcResponse = WorkerRpcSuccess | WorkerRpcFailure;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/**
 * Extra wall-clock the host waits beyond the effective in-sandbox timeout
 * before declaring the isolate wedged. The in-sandbox timer should always fire
 * first for a healthy isolate; this margin covers scheduling jitter and the RPC
 * unwind so a normally-timing-out execution reports its own descriptive timeout
 * rather than this backstop.
 */
const HOST_TIMEOUT_GRACE_MS = 30_000;
const ENTRY_MODULE = "executor.js";

const normalizeErrorObject = (error: Error) => ({
  __type: "Error" as const,
  name: error.name,
  message: error.message,
});

const isNormalizedErrorObject = (
  value: unknown,
): value is { readonly __type: "Error"; readonly message: string } =>
  typeof value === "object" &&
  value !== null &&
  "__type" in value &&
  value.__type === "Error" &&
  "message" in value &&
  typeof value.message === "string";

const serializeWorkerErrorValue = (value: unknown): SerializedWorkerErrorValue => {
  if (value instanceof Error) {
    return normalizeErrorObject(value);
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as SerializedWorkerErrorValue;
  } catch {
    return String(value);
  }
};

const renderTransportMessage = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (isNormalizedErrorObject(value)) {
    return value.message;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }

  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "undefined") {
    return "Unknown error";
  }

  return String(value);
};

const serializedErrorName = (value: SerializedWorkerErrorValue): string | null =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof (value as { name?: unknown }).name === "string"
    ? (value as { name: string }).name
    : null;

/**
 * Signatures of a compile error in the user's own code. Not all syntax
 * errors are caught while stripping TypeScript: smart quotes from a
 * paste, an unbalanced brace, and other plain-JS parse errors slip past
 * sucrase and only fail when workerd compiles the generated module,
 * surfacing as "Failed to start Worker: Uncaught SyntaxError: ...". The
 * bare V8 phrasings ("Unexpected token ...", "Invalid or unexpected
 * token") are matched too, since some surfaces report the inner message
 * without the wrapper.
 */
const COMPILE_SIGNATURES = [
  "Failed to start Worker",
  "SyntaxError",
  "Unexpected token",
  "Invalid or unexpected token",
] as const;

/**
 * Signatures of a sandbox runtime condition that is the user's own
 * concern (or transient and retryable) rather than an executor defect: a
 * non-serializable return value, the isolate's CPU or memory limit, and
 * being momentarily at worker capacity. These are the real categories
 * seen in production on the `executor.runtime.*` spans, all of which were
 * being collapsed to an opaque internal error before the model could act
 * on them.
 */
const RUNTIME_SIGNATURES = [
  "could not be cloned",
  "does not support serialization",
  "Could not serialize",
  "exceeded CPU",
  "exceeded memory",
  "Too many concurrent dynamic workers",
] as const;

export type SandboxFailureKind = "compilation" | "runtime" | "internal";

/**
 * Classify a sandbox rejection so the runtime knows whether to surface
 * its message descriptively (the user's mistake or a transient,
 * safe-to-report condition) or collapse it to an opaque internal error (a
 * genuine, unexpected sandbox defect). Tool-invocation failures never
 * reach here: the sandbox reports those through its own result envelope,
 * so this only sees module compile failures, return-value serialization
 * failures, isolate resource limits, and capacity rejections. Anything
 * unrecognized stays "internal" and opaque, preserving the host's
 * failure-channel boundary.
 */
export const classifySandboxFailure = (
  serialized: SerializedWorkerErrorValue,
  message: string,
): SandboxFailureKind => {
  const name = serializedErrorName(serialized);
  if (
    name === "SyntaxError" ||
    COMPILE_SIGNATURES.some((signature) => message.includes(signature))
  ) {
    return "compilation";
  }
  if (
    name === "DataCloneError" ||
    RUNTIME_SIGNATURES.some((signature) => message.includes(signature))
  ) {
    return "runtime";
  }
  return "internal";
};

/**
 * Map a raw sandbox rejection (a thrown value from the worker loader or
 * the `evaluate` RPC) to the typed error its classification calls for.
 * Compilation and runtime conditions carry the verbatim message through
 * the descriptive channel; unrecognized defects stay opaque.
 */
const toSandboxFailure = (
  cause: unknown,
): CodeCompilationError | SandboxRuntimeError | DynamicWorkerExecutionError => {
  const serialized = serializeWorkerErrorValue(cause);
  const message = renderTransportMessage(serialized);
  switch (classifySandboxFailure(serialized, message)) {
    case "compilation":
      return new CodeCompilationError({ runtime: "dynamic-worker", message, cause });
    case "runtime":
      return new SandboxRuntimeError({ runtime: "dynamic-worker", message, cause });
    default:
      return new DynamicWorkerExecutionError({ message });
  }
};

export const serializeWorkerCause = (cause: Cause.Cause<unknown>): SerializedWorkerError => {
  const failures = cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => serializeWorkerErrorValue(reason.error));
  const defects = cause.reasons
    .filter(Cause.isDieReason)
    .map((reason) => serializeWorkerErrorValue(reason.defect));
  const interrupted = cause.reasons.some(Cause.isInterruptReason);
  const primary = failures[0] ?? defects[0] ?? null;
  const kind =
    failures.length > 0 && defects.length > 0
      ? "mixed"
      : failures.length > 0
        ? "fail"
        : defects.length > 0
          ? "die"
          : interrupted
            ? "interrupt"
            : "unknown";

  return {
    kind,
    message:
      primary !== null
        ? renderTransportMessage(primary)
        : interrupted
          ? "Interrupted"
          : "Unknown error",
    primary,
    failures,
    defects,
    interrupted,
  };
};

export const renderWorkerError = (error: SerializedWorkerError): string => {
  if (isNormalizedErrorObject(error.primary)) {
    return error.primary.message;
  }

  if (typeof error.primary === "string") {
    return error.primary;
  }

  if (
    typeof error.primary === "object" &&
    error.primary !== null &&
    "message" in error.primary &&
    typeof error.primary.message === "string"
  ) {
    return error.primary.message;
  }

  if (typeof error.primary === "object" && error.primary !== null) {
    try {
      return JSON.stringify(error.primary);
    } catch {
      return error.message;
    }
  }

  return error.message;
};

export type { WorkerRpcResponse };

// ---------------------------------------------------------------------------
// Blob/File codec (both directions across the dispatcher boundary)
//
// Workers RPC's structured-clone allow-list excludes `Blob` / `File`, so
// we encode them to a tagged ArrayBuffer envelope and rehydrate on the
// far side. Symmetric in both directions: sandbox encodes args + host
// rehydrates them; host encodes result + sandbox rehydrates it. The
// matching encoder lives inside `module-template.ts` because it runs in
// the dynamic Worker isolate. `ArrayBuffer` / typed arrays / primitives
// cross structured clone natively.
// ---------------------------------------------------------------------------

type BinaryEnvelope = {
  readonly __executorBinary: 1;
  readonly kind: "blob" | "file";
  readonly type: string;
  readonly name?: string;
  readonly lastModified?: number;
  readonly buffer: ArrayBuffer;
};

const isBinaryEnvelope = (value: unknown): value is BinaryEnvelope =>
  typeof value === "object" &&
  value !== null &&
  (value as { __executorBinary?: unknown }).__executorBinary === 1 &&
  (value as { buffer?: unknown }).buffer instanceof ArrayBuffer &&
  typeof (value as { type?: unknown }).type === "string";

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const rehydrateBinary = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) {
    throw new Error("Tool RPC payload contains a circular reference");
  }
  seen.add(value);
  if (isBinaryEnvelope(value)) {
    seen.delete(value);
    if (value.kind === "file" && typeof value.name === "string") {
      return new File([value.buffer], value.name, {
        type: value.type,
        ...(typeof value.lastModified === "number" ? { lastModified: value.lastModified } : {}),
      });
    }
    return new Blob([value.buffer], { type: value.type });
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => rehydrateBinary(item, seen));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) {
    seen.delete(value);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = rehydrateBinary(v, seen);
  }
  seen.delete(value);
  return out;
};

// Async because `Blob.arrayBuffer()` is async. Used on tool results before
// the dispatcher hands them back to the sandbox.
const encodeBinary = async (value: unknown, seen = new WeakSet<object>()): Promise<unknown> => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) {
    throw new Error("Tool RPC payload contains a circular reference");
  }
  seen.add(value);
  if (typeof File !== "undefined" && value instanceof File) {
    const out = {
      __executorBinary: 1 as const,
      kind: "file" as const,
      type: value.type,
      name: value.name,
      lastModified: value.lastModified,
      buffer: await value.arrayBuffer(),
    };
    seen.delete(value);
    return out;
  }
  if (value instanceof Blob) {
    const out = {
      __executorBinary: 1 as const,
      kind: "blob" as const,
      type: value.type,
      buffer: await value.arrayBuffer(),
    };
    seen.delete(value);
    return out;
  }
  if (Array.isArray(value)) {
    const out = await Promise.all(value.map((item) => encodeBinary(item, seen)));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) {
    seen.delete(value);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = await encodeBinary(v, seen);
  }
  seen.delete(value);
  return out;
};

// ---------------------------------------------------------------------------
// ToolDispatcher — bridges RPC calls back to SandboxToolInvoker
// ---------------------------------------------------------------------------

/**
 * An `RpcTarget` passed to the dynamic Worker so that sandboxed code can
 * invoke tools on the host. The dynamic worker calls
 * `__dispatcher.call(path, args)` over Workers RPC. `Uint8Array` /
 * `ArrayBuffer` cross structured clone natively; `Blob` / `File` are
 * encoded sandbox-side as a tagged envelope and rehydrated here via
 * `rehydrateBinary` before the invoker sees them. JSON serialization on
 * this hop would replace those values with `"{}"` or numeric-keyed
 * objects, which is what broke `multipart/form-data` uploads.
 *
 * Each call is wrapped in an `executor.tool.rpc_dispatch` span so the
 * tool-invocation shell (Workers RPC roundtrip → local invoker →
 * serialize result) is visible in the trace. Tool-level attributes
 * like `mcp.tool.name` already come from the inner
 * `mcp.tool.dispatch` span that `tool-invoker.ts` wraps around
 * `executor.tools.invoke`.
 */
export type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

export class ToolDispatcher extends RpcTarget {
  readonly #invoker: SandboxToolInvoker;
  readonly #runPromise: RunPromise;
  // Number of tool round-trips currently in flight. The host-side execution
  // timeout is suspended while this is > 0: whenever the sandbox is blocked
  // here it is demonstrably not wedged (the host owns the continuation and
  // will resume it), so neither a slow tool call nor a minutes-long approval
  // pause (which manifests as an in-flight dispatch awaiting an elicitation
  // response) should count against the unresponsive-sandbox backstop.
  #inFlight = 0;
  #lastReturnedAt = Date.now();

  constructor(invoker: SandboxToolInvoker, runPromise: RunPromise) {
    super();
    this.#invoker = invoker;
    this.#runPromise = runPromise;
  }

  /** True while at least one tool round-trip is awaiting the host. */
  get isDispatching(): boolean {
    return this.#inFlight > 0;
  }

  /**
   * Epoch millis when the most recent tool round-trip returned control to the
   * sandbox (or dispatcher construction time if none has). Combined with
   * `isDispatching`, lets the host measure only the stretches where the sandbox
   * is expected to be computing on its own.
   */
  get lastReturnedAt(): number {
    return this.#lastReturnedAt;
  }

  async call(path: string, args: unknown): Promise<WorkerRpcResponse> {
    this.#inFlight += 1;
    try {
      return await this.#dispatch(path, args);
    } finally {
      this.#inFlight -= 1;
      this.#lastReturnedAt = Date.now();
    }
  }

  #dispatch(path: string, args: unknown): Promise<WorkerRpcResponse> {
    return this.#runPromise(
      Effect.try({
        try: () => rehydrateBinary(args),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((decodedArgs) => this.#invoker.invoke({ path, args: decodedArgs })),
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: (): Promise<WorkerRpcResponse> =>
              encodeBinary(value).then((result) => ({ ok: true, result })),
            // Encoding failed (e.g. Blob.arrayBuffer rejected) — surface
            // it as a normal failure envelope rather than throwing.
            catch: (cause) => cause,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed<WorkerRpcResponse>({
            ok: false,
            error: serializeWorkerCause(cause),
          }),
        ),
        Effect.withSpan("executor.tool.rpc_dispatch", {
          attributes: {
            "mcp.tool.name": path,
          },
        }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

type DynamicWorkerEntrypoint = {
  evaluate(dispatcher: ToolDispatcher): Promise<{
    result: unknown;
    output?: ExecuteOutputItem[];
    error?: SerializedWorkerError;
    logs?: string[];
  }>;
};

const asDynamicWorkerEntrypoint = (value: unknown): DynamicWorkerEntrypoint =>
  value as DynamicWorkerEntrypoint;

/**
 * Assemble the executor module source and ask the `WorkerLoader` for an
 * isolate. Spans the synchronous module-build + RPC-stub acquisition as
 * `executor.runtime.startup` so the trace separates "did we wait on
 * worker boot?" from the actual `evaluate` RPC roundtrip.
 */
const startDynamicWorker = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  timeoutMs: number,
): Effect.Effect<
  DynamicWorkerEntrypoint,
  DynamicWorkerExecutionError | CodeCompilationError | SandboxRuntimeError
> =>
  Effect.gen(function* () {
    // The dynamic Worker isolate only accepts plain JavaScript; TS type
    // syntax in user code (`: T`, `as T`, generics) would otherwise
    // surface as "Unexpected token ':'" inside `evaluate()`. Stripping
    // here means valid TS just works. But this step is also where a
    // genuine syntax error (smart quotes from a paste, an unbalanced
    // brace, `const = 5`) first surfaces, with the parser's precise
    // "Unexpected token (line:col)" message. That is the user's mistake,
    // not a sandbox defect, so it gets its own `CodeCompilationError`
    // and flows back through the descriptive `ExecuteResult.error`
    // channel rather than collapsing to an opaque internal error.
    const strippedBody = yield* Effect.try({
      try: () => stripTypeScript(recoverExecutionBody(code)),
      catch: (cause) =>
        new CodeCompilationError({
          runtime: "dynamic-worker",
          message: renderTransportMessage(serializeWorkerErrorValue(cause)),
          cause,
        }),
    });

    return yield* Effect.try({
      try: (): DynamicWorkerEntrypoint => {
        const executorModule = buildExecutorModule(strippedBody, timeoutMs);
        const { [ENTRY_MODULE]: _, ...safeModules } = options.modules ?? {};

        const worker = options.loader.get(`executor-${crypto.randomUUID()}`, () => ({
          compatibilityDate: "2025-06-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: ENTRY_MODULE,
          modules: {
            ...safeModules,
            [ENTRY_MODULE]: executorModule,
          },
          globalOutbound: options.globalOutbound ?? null,
        }));

        return asDynamicWorkerEntrypoint(worker.getEntrypoint());
      },
      // A compile error that escaped the strip step, or a capacity
      // rejection, can surface here at worker startup rather than at
      // `evaluate`. Classify it so the user-actionable reason reaches the
      // model instead of an opaque internal error.
      catch: toSandboxFailure,
    });
  }).pipe(
    Effect.withSpan("executor.runtime.startup", {
      attributes: {
        "executor.runtime": "dynamic-worker",
        "executor.code.length": code.length,
        "executor.timeout_ms": timeoutMs,
        "executor.extra_modules": Object.keys(options.modules ?? {}).length,
      },
    }),
  );

// ---------------------------------------------------------------------------
// Host-side execution timeout (unresponsive-sandbox backstop)
// ---------------------------------------------------------------------------

/** The subset of `ToolDispatcher` state the host watchdog observes. */
export type DispatcherActivity = {
  readonly isDispatching: boolean;
  readonly lastReturnedAt: number;
};

export type HostTimeoutOptions = {
  /** Effective in-sandbox timeout bound the sandbox itself enforces. */
  readonly timeoutMs: number;
  /** Extra wall-clock beyond the bound before declaring the isolate wedged. */
  readonly graceMs: number;
  /** Dispatcher activity — the host clock is suspended while it is dispatching. */
  readonly dispatcher: DispatcherActivity;
  /** Poll interval for the watchdog. Defaults to 1s. */
  readonly pollMs?: number;
  /** Emitted once when the backstop fires. */
  readonly onTimeout?: (info: { readonly elapsedMs: number }) => void;
  /** Clock injection for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * Race a (typed) evaluate Effect against a host-side watchdog that fires only
 * when the sandbox has gone unresponsive: no result and no host round-trip for
 * `timeoutMs + graceMs` of continuous compute time. The watchdog's reference
 * point advances every time a tool round-trip returns and is held at `now`
 * while a round-trip is in flight (a slow tool call or an approval pause), so
 * those never trip it. A true wedge (isolate evicted / OOM, RPC hung without
 * rejecting, no further dispatch) leaves the reference point stationary and the
 * watchdog fires, failing with a `SandboxHostTimeoutError`.
 *
 * Takes the evaluate step as a pre-built Effect (not a raw promise) so the
 * caller keeps its own error classification, and so a test can drive it with an
 * Effect wrapping a never-settling promise (no live WorkerLoader needed).
 */
export const runEvaluateWithHostTimeout = <A, E>(
  evaluated: Effect.Effect<A, E>,
  options: HostTimeoutOptions,
): Effect.Effect<A, E | SandboxHostTimeoutError> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const bound = Math.max(0, options.timeoutMs) + Math.max(0, options.graceMs);
    const pollMs = Math.max(1, options.pollMs ?? 1_000);
    const start = now();

    const completion = evaluated.pipe(
      Effect.map((value): TimeoutRace<A> => ({ kind: "done", value })),
    );

    // Poll the dispatcher's activity. `reference` is the latest instant from
    // which the sandbox is expected to be computing on its own: execution
    // start, bumped forward to each round-trip's return, and pinned to `now`
    // for as long as a round-trip is outstanding. The watchdog fires when the
    // sandbox has been on its own for `bound` ms without producing a result.
    const watchdog: Effect.Effect<TimeoutRace<A>> = Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(pollMs);
        const current = now();
        const reference = options.dispatcher.isDispatching
          ? current
          : Math.max(start, options.dispatcher.lastReturnedAt);
        if (current - reference >= bound) {
          return { kind: "timeout", elapsedMs: current - start };
        }
      }
    });

    const outcome = yield* Effect.raceFirst(completion, watchdog);
    if (outcome.kind === "timeout") {
      options.onTimeout?.({ elapsedMs: outcome.elapsedMs });
      return yield* new SandboxHostTimeoutError({
        runtime: "dynamic-worker",
        message: `execution exceeded ${bound}ms (sandbox unresponsive)`,
        timeoutMs: bound,
        elapsedMs: outcome.elapsedMs,
      });
    }
    return outcome.value;
  });

type TimeoutRace<A> =
  | { readonly kind: "done"; readonly value: A }
  | { readonly kind: "timeout"; readonly elapsedMs: number };

const evaluate = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<
  ExecuteResult,
  DynamicWorkerExecutionError | CodeCompilationError | SandboxRuntimeError | SandboxHostTimeoutError
> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const dispatcher = new ToolDispatcher(toolInvoker, Effect.runPromiseWith(context));
    const entrypoint = yield* startDynamicWorker(options, code, timeoutMs);
    // The evaluate RPC rejects for module compile failures that escaped the
    // strip step, non-serializable return values, isolate resource limits, and
    // capacity. All are the user's concern or transient, so classify and
    // surface them descriptively rather than opaquely.
    const evaluated = Effect.tryPromise({
      try: () => entrypoint.evaluate(dispatcher),
      catch: toSandboxFailure,
    });
    const graceMs = Math.max(0, options.hostTimeoutGraceMs ?? HOST_TIMEOUT_GRACE_MS);
    const response = yield* runEvaluateWithHostTimeout(evaluated, {
      timeoutMs,
      graceMs,
      pollMs: options.hostTimeoutPollMs,
      dispatcher,
      onTimeout: ({ elapsedMs }) => {
        // Structured, greppable event for the alerting workstream. Kept off the
        // trace span (which is interrupted by the race) so it always lands.
        // oxlint-disable-next-line no-console -- boundary: structured host-timeout telemetry event
        console.error(
          JSON.stringify({
            event: "mcp_execution_host_timeout",
            elapsedMs,
            timeoutMs: timeoutMs + graceMs,
          }),
        );
      },
    }).pipe(
      Effect.withSpan("executor.runtime.evaluate", {
        attributes: { "executor.runtime": "dynamic-worker" },
      }),
    );
    const error = response.error ? renderWorkerError(response.error) : undefined;
    return {
      result: error ? null : response.result,
      error,
      output:
        Array.isArray(response.output) && response.output.length > 0 ? response.output : undefined,
      logs: response.logs,
    } satisfies ExecuteResult;
  });
};

// ---------------------------------------------------------------------------
// Effect wrapper
// ---------------------------------------------------------------------------

const runInDynamicWorker = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<ExecuteResult, DynamicWorkerExecutionError> =>
  evaluate(options, code, toolInvoker).pipe(
    // A compile error or a reportable sandbox runtime condition (a
    // non-serializable result, a CPU/memory limit, capacity) is the
    // user's own concern or transient, not a sandbox defect. Fold both
    // into the success channel as a descriptive `ExecuteResult.error` so
    // the precise reason reaches the model, exactly as a thrown runtime
    // error does, instead of being collapsed to an opaque internal error
    // by the host failure path. Unrecognized defects stay on
    // `DynamicWorkerExecutionError` and remain opaque.
    Effect.catchTags({
      CodeCompilationError: (error) =>
        Effect.succeed({ result: null, error: error.message } satisfies ExecuteResult),
      SandboxRuntimeError: (error) =>
        Effect.succeed({ result: null, error: error.message } satisfies ExecuteResult),
      // A wedged isolate that the in-sandbox timer failed to catch is
      // unrecoverable, but reporting it as a delivered, descriptive error beats
      // the original symptom (open-ended silence). Fold it into the success
      // channel like the other safe-to-report conditions so it reaches the
      // model instead of collapsing to an opaque internal error.
      SandboxHostTimeoutError: (error) =>
        Effect.succeed({ result: null, error: error.message } satisfies ExecuteResult),
    }),
    Effect.withSpan("executor.code.exec.dynamic_worker", {
      attributes: { "executor.runtime": "dynamic-worker" },
    }),
  );

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const makeDynamicWorkerExecutor = (
  options: DynamicWorkerExecutorOptions,
): CodeExecutor<DynamicWorkerExecutionError> => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    runInDynamicWorker(options, code, toolInvoker),
  // The effective in-sandbox bound, exposed so hosts can reason about the
  // execution budget. `evaluate` clamps to a 100ms floor identically.
  timeoutMs: Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
});
