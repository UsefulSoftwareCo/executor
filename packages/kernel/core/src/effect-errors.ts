import * as Data from "effect/Data";

export class KernelCoreEffectError extends Data.TaggedError("KernelCoreEffectError")<{
  readonly module: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Default failure type for any `CodeExecutor.execute` implementation —
 * surfaces sandbox-level defects (isolate crash, module load failure,
 * worker loader error) as a typed error so callers can handle them
 * structurally instead of untyped `unknown`. Runtimes that want a
 * narrower error shape can define their own `Data.TaggedError` subclass
 * and parameterize `CodeExecutor<MyError>`.
 */
export class CodeExecutionError extends Data.TaggedError("CodeExecutionError")<{
  readonly runtime: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when user code fails to compile before it ever runs: a genuine
 * syntax/parse error (smart quotes from a copy-paste, an unbalanced
 * brace, `const = 5`) caught while stripping TypeScript ahead of the
 * JS-only sandbox. Unlike `CodeExecutionError` this is the user's
 * mistake, not a sandbox defect, so runtimes surface its `message`
 * through the descriptive `ExecuteResult.error` channel instead of
 * collapsing it to an opaque internal-error string. The original parser
 * message (e.g. "Unexpected token (1:54)") is carried verbatim so the
 * model can see and fix it.
 */
export class CodeCompilationError extends Data.TaggedError("CodeCompilationError")<{
  readonly runtime: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when the sandbox cannot run the user's code to completion for a
 * reason that is not a syntax error but is still safe and useful to
 * report back: the returned value is not serializable across the sandbox
 * boundary (a Symbol, a host object like `Cloudflare`), the code exceeded
 * the isolate's CPU or memory limit, or the sandbox is momentarily at
 * capacity. Like `CodeCompilationError`, and unlike `CodeExecutionError`,
 * this describes the user's own code or a transient, retryable condition
 * rather than an executor defect, so runtimes surface its verbatim
 * `message` through the descriptive `ExecuteResult.error` channel instead
 * of collapsing it to an opaque internal-error string. Genuinely
 * unexpected sandbox defects stay on `CodeExecutionError` and remain
 * opaque, preserving the host's failure-channel boundary.
 */
export class SandboxRuntimeError extends Data.TaggedError("SandboxRuntimeError")<{
  readonly runtime: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised on the host side when a sandbox execution never settles within its
 * effective timeout bound (plus a grace margin) AND is not merely blocked in a
 * host round-trip (a tool call or an approval pause). This is the backstop for
 * a wedged isolate: if the isolate is evicted / OOM-killed in a way that hangs
 * the cross-isolate RPC without rejecting, the in-sandbox timer never fires and
 * the host would otherwise wait forever, surfacing to the client as pure
 * silence. Like `SandboxRuntimeError`, this is a safe-to-report condition (the
 * execution is unrecoverable but the failure is descriptive, not an internal
 * defect), so runtimes surface its `message` through the descriptive
 * `ExecuteResult.error` channel rather than collapsing it to an opaque internal
 * error. The host clock is suspended while the sandbox is blocked in a host
 * round-trip, so a long-running tool call or a minutes-long approval pause does
 * NOT trip it: it fires only when the sandbox is supposed to be computing on
 * its own and has gone unresponsive.
 */
export class SandboxHostTimeoutError extends Data.TaggedError("SandboxHostTimeoutError")<{
  readonly runtime: string;
  readonly message: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
}> {}
