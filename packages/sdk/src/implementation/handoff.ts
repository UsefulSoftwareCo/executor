/**
 * A one-time result that fibers of other requests may wait for.
 *
 * An Effect `Deferred`, latch or `Effect.cached` resumes its waiters synchronously inside the fiber
 * that completes it. On Workers that fiber may belong to another request, and a waiter resumed
 * there keeps running in that request's I/O context: its own RPC stubs, sockets and streams then
 * fail with "Cannot perform I/O on behalf of a different request", and the I/O it starts is
 * cancelled when that request ends. A handoff settles a native promise instead. The runtime runs
 * each waiter's continuation in the request that registered it.
 */
import { Effect } from "effect";

export interface Handoff<A> {
  /** Waits for the value; interrupting a waiter leaves the handoff and other waiters alone. */
  readonly await: Effect.Effect<A>;
  /** Settles the handoff once. Returns false when it was already settled. */
  readonly settle: (value: A) => Effect.Effect<boolean>;
  /** Whether it has settled, so a new waiter would have the value at once. */
  readonly isSettled: () => boolean;
}

export const makeHandoff = <A>(): Handoff<A> => {
  let resolve: (value: A) => void = () => undefined;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  let settled = false;
  return {
    await: Effect.promise(() => promise),
    settle: (value) =>
      Effect.sync(() => {
        if (settled) return false;
        settled = true;
        resolve(value);
        return true;
      }),
    isSettled: () => settled,
  };
};
