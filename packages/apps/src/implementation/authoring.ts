/** Small, explicit adapters between authored callbacks and native Effect operations. */
import { Effect } from "effect";

const NativeCallback = Symbol("apps.NativeCallback");

/** Project one Effect operation into its author-facing Promise signature. */
export type PromiseMethod<Method> = Method extends (
  ...args: infer Args
) => Effect.Effect<infer A, infer _E>
  ? (...args: Args) => Promise<A>
  : Method;

/** Project only an object's methods; data and schema types are not recursively rewritten. */
export type PromiseMethods<T> = { readonly [Key in keyof T]: PromiseMethod<T[Key]> };

/** Reuse a framework callback's cancellation-bound Effect, or adapt an ordinary async callback. */
export const fromPromise =
  <Args extends readonly unknown[], A>(
    callback: (...args: Args) => Promise<A>,
  ): ((...args: Args) => Effect.Effect<A, unknown>) =>
  (...args) => {
    if (NativeCallback in callback) {
      // SAFETY: this private symbol is installed only by toPromise on the same
      // callback signature. Preserve native composition instead of starting a runtime.
      const native = callback[NativeCallback] as (...args: Args) => Effect.Effect<A, unknown>;
      return native(...args);
    }
    return Effect.tryPromise({ try: () => callback(...args), catch: (error) => error });
  };

/** Bind cancellation once so Promise callers and native framework callers run the same operation. */
export const toPromise = <Args extends readonly unknown[], A, E>(
  operation: (...args: Args) => Effect.Effect<A, E>,
  signal?: AbortSignal,
): ((...args: Args) => Promise<A>) => {
  const native = (...args: Args): Effect.Effect<A, E> =>
    Effect.suspend(() => {
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
  return Object.assign((...args: Args) => Effect.runPromise(native(...args)), {
    [NativeCallback]: native,
  });
};
