/** Small, explicit adapters between authored callbacks and native Effect operations. */
import { Effect, type Context } from "effect";
import { owned } from "@executor-js/telemetry";

const NativeCallback = Symbol("apps.NativeCallback");

/** Project one Effect operation into its author-facing Promise signature. */
export type PromiseMethod<Method> = Method extends (
  ...args: infer Args
) => Effect.Effect<infer A, infer _E>
  ? (...args: Args) => Promise<A>
  : Method;

/** Project only an object's methods; data and schema types are not recursively rewritten. */
export type PromiseMethods<T> = { readonly [Key in keyof T]: PromiseMethod<T[Key]> };

/** Which of the app's callbacks runs, recorded on the `app.code` span around it. */
export type AppCode =
  | "factory"
  | "router"
  | "approval"
  | "handler"
  | "loader"
  | "cache"
  | "webhook"
  | "check"
  | "skills"
  | "elicitation"
  | "workflow"
  | "step";

/**
 * Run `effect` as the app's own code. Its time is the app's, except for work it starts for
 * Executor, an upstream or a person, which opens its own boundary inside.
 */
export const appCode = (code: AppCode) =>
  owned("app", "app.code", { attributes: { "executor.app.code": code } });

/**
 * Reuse a framework callback's cancellation-bound Effect, or run an ordinary async callback as the
 * app's code. Every callback an app supplies enters the framework here, so its time is the app's.
 */
export const fromPromise =
  <Args extends readonly unknown[], A>(
    callback: (...args: Args) => Promise<A>,
    code: AppCode,
  ): ((...args: Args) => Effect.Effect<A, unknown>) =>
  (...args) => {
    if (NativeCallback in callback) {
      // SAFETY: this private symbol is installed only by toPromise on the same
      // callback signature. Preserve native composition instead of starting a runtime.
      const native = callback[NativeCallback] as (...args: Args) => Effect.Effect<A, unknown>;
      return native(...args);
    }
    return Effect.tryPromise({ try: () => callback(...args), catch: (error) => error }).pipe(
      appCode(code),
    );
  };

/**
 * `target[key]`, called on `target`. A method read off its object as a bare value loses its
 * receiver, so an app's method, such as one of its cache's, enters `fromPromise` through this.
 */
export const method = <
  K extends PropertyKey,
  T extends { readonly [P in K]: (...args: never) => unknown },
>(
  target: T,
  key: K,
): T[K] => {
  const value = target[key];
  const call = (...args: unknown[]): unknown => Reflect.apply(value, target, args);
  // Executor's own methods keep their native operation, so `fromPromise` still composes them.
  if (NativeCallback in value) Object.assign(call, { [NativeCallback]: value[NativeCallback] });
  // SAFETY: `call` passes every argument and the result through unchanged, on `target`.
  return call as unknown as T[K];
};

/**
 * Bind cancellation once so Promise callers and native framework callers run the same operation.
 * `signalOf` is the signal, or reads it from each call's arguments, such as a loader's `context.signal`.
 */
export const toPromise = <Args extends readonly unknown[], A, E>(
  operation: (...args: Args) => Effect.Effect<A, E>,
  signalOf?: AbortSignal | ((...args: Args) => AbortSignal),
  /** Services a Promise call runs with, such as its invocation's telemetry. */
  services?: Context.Context<never>,
): ((...args: Args) => Promise<A>) => {
  const native = (...args: Args): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const signal = typeof signalOf === "function" ? signalOf(...args) : signalOf;
      if (signal === undefined) return operation(...args);
      if (signal.aborted) return Effect.interrupt;
      const cancelled = Effect.callback<never>((resume) => {
        if (signal.aborted) {
          resume(Effect.interrupt);
          return;
        }
        const abort = () => resume(Effect.interrupt);
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      });
      return Effect.raceFirst(
        cancelled,
        Effect.suspend(() => operation(...args)),
      );
    });
  return Object.assign(
    (...args: Args) =>
      services === undefined
        ? Effect.runPromise(native(...args))
        : Effect.runPromiseWith(services)(native(...args)),
    {
      [NativeCallback]: native,
    },
  );
};
