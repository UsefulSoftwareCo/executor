/**
 * Run a self-contained JS bundle in a QuickJS sandbox and read one string back.
 *
 * ## Why this exists next to `makeQuickJsExecutor`
 *
 * `CodeExecutor` is the *user execution* contract: it recovers a body from
 * model-written code, injects `tools`/`console`/`emit`, dispatches tool calls
 * back to the host, and — on cloud — is wrapped in metering, quota and rate
 * limiting, because every call through it is something a user asked for and is
 * billed for.
 *
 * A validation render is none of those things. It has no tools (every call must
 * hang, by design), no logs anyone reads, no result but a verdict, and it is
 * not a user execution — refusing it for quota, or billing someone for typing,
 * would both be wrong. It also must not pay `CodeExecutor`'s preprocessing:
 * `recoverExecutionBody` + `stripTypeScript` spend ~600ms parsing a
 * megabyte-scale prebuilt bundle that is already plain ES2022 with nothing to
 * strip.
 *
 * So this is a deliberately smaller primitive: no tool bridge, no code
 * recovery, no transform. A sealed bundle goes in, one string comes out. It
 * sits BELOW every gating layer by construction, because it never touches the
 * `Executor`, the engine, or anything that knows what an organization is.
 *
 * ## Why QuickJS, on every host
 *
 * QuickJS is a WASM interpreter. The code it runs is interpreted by the engine
 * compiled into the WASM module, never by the host's own JS engine — so
 * `new Function` inside the sandbox is QuickJS building a QuickJS function, not
 * V8 compiling a string. That is why this works unchanged on workerd, whose ban
 * on runtime codegen is a ban on *V8* codegen, and it is the same reason
 * executor already runs model `execute` code through QuickJS on Cloudflare.
 *
 * ## What the sandbox cannot reach
 *
 * A fresh runtime and context per call, disposed after. The context starts with
 * only what QuickJS itself defines: no `process`, no `fetch`, no `require`, no
 * host object of any kind is ever installed on the global. Memory, stack depth
 * and wall-clock are all capped, and the interrupt handler preempts a
 * synchronous infinite loop — which the host process cannot do to itself.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { getQuickJS, type QuickJSContext, type QuickJSWASMModule } from "quickjs-emscripten";

/** Raised when the sandbox could not produce an answer — never when the code
 *  the sandbox ran merely failed. The caller decides what to do with it; every
 *  current caller fails open. */
export class SealedBundleError extends Data.TaggedError("SealedBundleError")<{
  readonly message: string;
}> {}

export type SealedBundleOptions = {
  /** The program. Must be self-contained: no imports, no host globals. */
  readonly bundle: string;
  /**
   * An expression evaluated after the bundle, whose value is awaited and must
   * resolve to a string. Kept an expression rather than a function name so the
   * caller decides how to pass its own arguments — always by embedding them as
   * JSON literals, never by installing them as globals.
   */
  readonly call: string;
  readonly timeoutMs?: number;
  readonly memoryLimitBytes?: number;
  readonly maxStackSizeBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
// A React server render of the component barrel peaks well under this; the
// spike ran comfortably in 32 MiB. Headroom, not a target.
const DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 2 * 1024 * 1024;

const BUNDLE_FILENAME = "executor-sealed-bundle.js";
const CALL_FILENAME = "executor-sealed-call.js";

/** Set by `setQuickJSModule` in this package's main entry. Read lazily so a
 *  host that preloads a custom WASM module (Workers must) is honoured. */
type ModuleResolver = () => Promise<QuickJSWASMModule>;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Evaluate one chunk, converting QuickJS's error handle into a thrown Error
 *  whose message is the sandbox's own. */
const evaluate = (context: QuickJSContext, source: string, filename: string): void => {
  const result = context.evalCode(source, filename);
  if (result.error) {
    const dumped: unknown = context.dump(result.error);
    result.error.dispose();
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: QuickJS reports failure as a handle; this is where it becomes a JS error
    throw new Error(
      typeof dumped === "object" && dumped !== null && "message" in dumped
        ? String((dumped as { message: unknown }).message)
        : String(dumped),
    );
  }
  result.value.dispose();
};

const runSealedBundle = async (
  options: SealedBundleOptions,
  resolveModule: ModuleResolver,
): Promise<string> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const QuickJS = await resolveModule();
  const runtime = QuickJS.newRuntime();

  try {
    runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES);

    // The deadline is absolute and never suspended: unlike `execute`, nothing
    // here waits on a host round-trip, so any time spent is time the sandbox
    // spent computing. This is what preempts `while (true)` in a component.
    const deadline = Date.now() + timeoutMs;
    runtime.setInterruptHandler(() => Date.now() >= deadline);

    const context = runtime.newContext();
    try {
      evaluate(context, options.bundle, BUNDLE_FILENAME);

      // The call's promise is settled into a plain object the host can read
      // without holding a live promise handle across the drain.
      evaluate(
        context,
        `globalThis.__executor_sealed = { settled: false, value: undefined, error: undefined };
         Promise.resolve(${options.call}).then(
           function (value) { globalThis.__executor_sealed.value = value; globalThis.__executor_sealed.settled = true; },
           function (error) {
             globalThis.__executor_sealed.error = error && error.message ? String(error.message) : String(error);
             globalThis.__executor_sealed.settled = true;
           },
         );`,
        CALL_FILENAME,
      );

      // Everything in a sealed bundle is synchronous or a microtask — there are
      // no host callbacks to await — so draining pending jobs to exhaustion
      // settles it. `executePendingJobs` returns once no job remains; the
      // interrupt handler stops a job that will not end.
      const drained = runtime.executePendingJobs();
      if (drained.error) {
        const dumped: unknown = context.dump(drained.error);
        drained.error.dispose();
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: same as `evaluate`, for the microtask drain
        throw new Error(errorMessage(dumped));
      }

      const stateHandle = context.getProp(context.global, "__executor_sealed");
      try {
        const state = context.dump(stateHandle) as {
          settled?: boolean;
          value?: unknown;
          error?: unknown;
        };
        if (state.settled !== true) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: an unsettled drain is a sandbox failure, reported to the caller
          throw new Error(`Sealed bundle did not settle within ${timeoutMs}ms`);
        }
        if (state.error !== undefined) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: propagate the sandbox's own rejection
          throw new Error(String(state.error));
        }
        if (typeof state.value !== "string") {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the contract is one string
          throw new Error(`Sealed bundle resolved a ${typeof state.value}, expected a string`);
        }
        return state.value;
      } finally {
        stateHandle.dispose();
      }
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
};

/**
 * Run `bundle`, then `call`, in a fresh QuickJS sandbox; resolve its string.
 *
 * Fails with `SealedBundleError` for every sandbox-side problem — a bundle that
 * throws while loading, a call that rejects, a deadline, a memory cap. Callers
 * that treat validation as advisory should fail open on it.
 */
export const executeSealedBundle = (
  options: SealedBundleOptions,
  resolveModule: ModuleResolver,
): Effect.Effect<string, SealedBundleError> =>
  Effect.tryPromise({
    try: () => runSealedBundle(options, resolveModule),
    catch: (cause) => new SealedBundleError({ message: errorMessage(cause) }),
  }).pipe(
    Effect.withSpan("executor.sealed_bundle.exec", {
      attributes: { "executor.runtime": "quickjs" },
    }),
  );

/** The default module resolver: the preloaded WASM module when a host set one
 *  (Workers must), otherwise the package's own. */
export const defaultQuickJsModuleResolver =
  (preloaded: () => QuickJSWASMModule | null): ModuleResolver =>
  () => {
    const module = preloaded();
    return module ? Promise.resolve(module) : getQuickJS();
  };
