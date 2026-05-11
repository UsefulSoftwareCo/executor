import {
  recoverExecutionBody,
  stripTypeScript,
  type CodeExecutor,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor-js/codemode-core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

export type QuickJsExecutorOptions = {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
};

// Allow pre-loading a QuickJS module (e.g. with custom WASM bytes for compiled binaries)
let preloadedModule: QuickJSWASMModule | null = null;

export const setQuickJSModule = (mod: QuickJSWASMModule) => {
  preloadedModule = mod;
};

const resolveQuickJS = (): Promise<QuickJSWASMModule> =>
  preloadedModule ? Promise.resolve(preloadedModule) : getQuickJS();

class QuickJsExecutionError extends Data.TaggedError("QuickJsExecutionError")<{
  readonly message: string;
}> {}

// Large OpenAPI specs can take longer to parse inside QuickJS, so keep the
// default execution budget at five minutes unless a caller opts into less.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 1 * 1024 * 1024;
const EXECUTION_FILENAME = "executor-quickjs-runtime.js";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const toErrorMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const message =
      "message" in cause && typeof cause.message === "string" ? cause.message : undefined;

    if (message) {
      return message;
    }

    const stack = "stack" in cause && typeof cause.stack === "string" ? cause.stack : undefined;

    if (stack) {
      return stack;
    }
  }

  const error = toError(cause);
  return error.stack ?? error.message;
};

const serializeJson = (value: unknown, label: string): string | undefined => {
  if (typeof value === "undefined") {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new Error(`${label} is not JSON serializable: ${toError(cause).message}`);
  }
};

const looksLikeInterruptedError = (message: string): boolean => /\binterrupted\b/i.test(message);

const timeoutMessage = (timeoutMs: number): string =>
  `QuickJS execution timed out after ${timeoutMs}ms`;

const normalizeExecutionError = (cause: unknown, deadlineMs: number, timeoutMs: number): string => {
  const message = toErrorMessage(cause);
  return Date.now() >= deadlineMs && looksLikeInterruptedError(message)
    ? timeoutMessage(timeoutMs)
    : message;
};

const buildExecutionSource = (code: string): string => {
  // QuickJS evaluates plain JavaScript only; strip any TS type syntax
  // first. A parse failure here throws a SyntaxError which the outer
  // `Effect.tryPromise` maps to `QuickJsExecutionError` with the
  // sucrase-formatted message intact.
  const body = stripTypeScript(recoverExecutionBody(code));

  return [
    '"use strict";',
    "const __invokeTool = __executor_invokeTool;",
    "const __log = __executor_log;",
    "try { delete globalThis.__executor_invokeTool; } catch {}",
    "try { delete globalThis.__executor_log; } catch {}",
    "const __formatLogArg = (value) => {",
    "  if (typeof value === 'string') return value;",
    "  try {",
    "    return JSON.stringify(value);",
    "  } catch {",
    "    return String(value);",
    "  }",
    "};",
    "const __formatLogLine = (args) => args.map(__formatLogArg).join(' ');",
    "const __makeToolsProxy = (path = []) => new Proxy(() => undefined, {",
    "  get(_target, prop) {",
    "    if (prop === 'then' || typeof prop === 'symbol') {",
    "      return undefined;",
    "    }",
    "    return __makeToolsProxy([...path, String(prop)]);",
    "  },",
    "  apply(_target, _thisArg, args) {",
    "    const toolPath = path.join('.');",
    "    if (!toolPath) {",
    "      throw new Error('Tool path missing in invocation');",
    "    }",
    "    return Promise.resolve(__invokeTool(toolPath, args[0])).then((raw) => raw === undefined ? undefined : JSON.parse(raw));",
    "  },",
    "});",
    "const tools = __makeToolsProxy();",
    "const console = {",
    "  log: (...args) => __log('log', __formatLogLine(args)),",
    "  warn: (...args) => __log('warn', __formatLogLine(args)),",
    "  error: (...args) => __log('error', __formatLogLine(args)),",
    "  info: (...args) => __log('info', __formatLogLine(args)),",
    "  debug: (...args) => __log('debug', __formatLogLine(args)),",
    "};",
    "const fetch = (..._args) => {",
    "  throw new Error('fetch is disabled in QuickJS executor');",
    "};",
    "(async () => {",
    body,
    "})()",
  ].join("\n");
};

const readPropDump = (context: QuickJSContext, handle: QuickJSHandle, key: string): unknown => {
  const prop = context.getProp(handle, key);
  try {
    return context.dump(prop);
  } finally {
    prop.dispose();
  }
};

const readResultState = (
  context: QuickJSContext,
  handle: QuickJSHandle,
): {
  settled: boolean;
  value: unknown;
  error: unknown;
} => ({
  settled: readPropDump(context, handle, "settled") === true,
  value: readPropDump(context, handle, "v"),
  error: readPropDump(context, handle, "e"),
});

const createLogBridge = (context: QuickJSContext, logs: string[]): QuickJSHandle =>
  context.newFunction("__executor_log", (levelHandle, lineHandle) => {
    const level = context.getString(levelHandle);
    const line = context.getString(lineHandle);
    logs.push(`[${level}] ${line}`);
    return context.undefined;
  });

type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const createToolBridge = (
  context: QuickJSContext,
  toolInvoker: SandboxToolInvoker,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
  runPromise: RunPromise,
): QuickJSHandle =>
  context.newFunction("__executor_invokeTool", (pathHandle, argsHandle) => {
    const path = context.getString(pathHandle);
    const args =
      argsHandle === undefined || context.typeof(argsHandle) === "undefined"
        ? undefined
        : context.dump(argsHandle);
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);
    deferred.settled.finally(() => {
      pendingDeferreds.delete(deferred);
    });

    void runPromise(toolInvoker.invoke({ path, args })).then(
      (value) => {
        if (!deferred.alive) {
          return;
        }

        const serialized = serializeJson(value, `Tool result for ${path}`);
        if (typeof serialized === "undefined") {
          deferred.resolve();
          return;
        }

        const valueHandle = context.newString(serialized);
        deferred.resolve(valueHandle);
        valueHandle.dispose();
      },
      (cause) => {
        if (!deferred.alive) {
          return;
        }

        const errorHandle = context.newError(toErrorMessage(cause));
        deferred.reject(errorHandle);
        errorHandle.dispose();
      },
    );

    return deferred.handle;
  });

const drainJobs = (
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  deadlineMs: number,
  timeoutMs: number,
): void => {
  while (runtime.hasPendingJob()) {
    if (Date.now() >= deadlineMs) {
      throw new Error(timeoutMessage(timeoutMs));
    }

    const pending = runtime.executePendingJobs();
    if (pending.error) {
      const error = context.dump(pending.error);
      pending.error.dispose();
      throw toError(error);
    }
  }
};

const waitForDeferreds = async (
  pendingDeferreds: ReadonlySet<QuickJSDeferredPromise>,
  deadlineMs: number,
  timeoutMs: number,
): Promise<void> => {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutMessage(timeoutMs));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.race([...pendingDeferreds].map((deferred) => deferred.settled)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage(timeoutMs))), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const drainAsync = async (
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  pendingDeferreds: ReadonlySet<QuickJSDeferredPromise>,
  deadlineMs: number,
  timeoutMs: number,
): Promise<void> => {
  drainJobs(context, runtime, deadlineMs, timeoutMs);

  while (pendingDeferreds.size > 0) {
    await waitForDeferreds(pendingDeferreds, deadlineMs, timeoutMs);
    drainJobs(context, runtime, deadlineMs, timeoutMs);
  }

  drainJobs(context, runtime, deadlineMs, timeoutMs);
};

const evaluateInQuickJs = async (
  options: QuickJsExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
  runPromise: RunPromise,
): Promise<ExecuteResult> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadlineMs = Date.now() + timeoutMs;
  const logs: string[] = [];
  const pendingDeferreds = new Set<QuickJSDeferredPromise>();
  const QuickJS = await resolveQuickJS();
  const runtime = QuickJS.newRuntime();

  try {
    runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES);

    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadlineMs));

    const context = runtime.newContext();
    try {
      const logBridge = createLogBridge(context, logs);
      context.setProp(context.global, "__executor_log", logBridge);
      logBridge.dispose();

      const toolBridge = createToolBridge(context, toolInvoker, pendingDeferreds, runPromise);
      context.setProp(context.global, "__executor_invokeTool", toolBridge);
      toolBridge.dispose();

      const evaluated = context.evalCode(buildExecutionSource(code), EXECUTION_FILENAME);
      if (evaluated.error) {
        const error = context.dump(evaluated.error);
        evaluated.error.dispose();
        return {
          result: null,
          error: normalizeExecutionError(error, deadlineMs, timeoutMs),
          logs,
        } satisfies ExecuteResult;
      }

      context.setProp(context.global, "__executor_result", evaluated.value);
      evaluated.value.dispose();

      const stateResult = context.evalCode(
        "(function(p){ var s = { v: void 0, e: void 0, settled: false }; var formatError = function(e){ if (e && typeof e === 'object') { var message = typeof e.message === 'string' ? e.message : ''; var stack = typeof e.stack === 'string' ? e.stack : ''; if (message && stack) { return stack.indexOf(message) === -1 ? message + '\\n' + stack : stack; } if (message) return message; if (stack) return stack; } return String(e); }; p.then(function(v){ s.v = v; s.settled = true; }, function(e){ s.e = formatError(e); s.settled = true; }); return s; })(__executor_result)",
      );
      if (stateResult.error) {
        const error = context.dump(stateResult.error);
        stateResult.error.dispose();
        return {
          result: null,
          error: normalizeExecutionError(error, deadlineMs, timeoutMs),
          logs,
        } satisfies ExecuteResult;
      }

      const stateHandle = stateResult.value;
      try {
        await drainAsync(context, runtime, pendingDeferreds, deadlineMs, timeoutMs);
        const state = readResultState(context, stateHandle);
        if (!state.settled) {
          return {
            result: null,
            error: timeoutMessage(timeoutMs),
            logs,
          } satisfies ExecuteResult;
        }

        if (typeof state.error !== "undefined") {
          return {
            result: null,
            error: normalizeExecutionError(state.error, deadlineMs, timeoutMs),
            logs,
          } satisfies ExecuteResult;
        }

        return {
          result: state.value,
          logs,
        } satisfies ExecuteResult;
      } finally {
        stateHandle.dispose();
      }
    } finally {
      for (const deferred of pendingDeferreds) {
        if (deferred.alive) {
          deferred.dispose();
        }
      }

      pendingDeferreds.clear();
      context.dispose();
    }
  } catch (cause) {
    return {
      result: null,
      error: normalizeExecutionError(cause, deadlineMs, timeoutMs),
      logs,
    } satisfies ExecuteResult;
  } finally {
    runtime.dispose();
  }
};

const runInQuickJs = (
  options: QuickJsExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<ExecuteResult, QuickJsExecutionError> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    return yield* Effect.tryPromise({
      try: () => evaluateInQuickJs(options, code, toolInvoker, runPromise),
      catch: (cause) => new QuickJsExecutionError({ message: String(cause) }),
    });
  }).pipe(
    Effect.withSpan("executor.code.exec.quickjs", {
      attributes: { "executor.runtime": "quickjs" },
    }),
  );

export const makeQuickJsExecutor = (
  options: QuickJsExecutorOptions = {},
): CodeExecutor<QuickJsExecutionError> => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    runInQuickJs(options, code, toolInvoker),
});
