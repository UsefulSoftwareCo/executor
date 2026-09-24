import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Option from "effect/Option";

export function isAsyncResultLoading<A, E>(result: AsyncResult.AsyncResult<A, E>): boolean {
  return (
    AsyncResult.isInitial(result) ||
    (AsyncResult.isWaiting(result) && Option.isNone(AsyncResult.value(result)))
  );
}

/**
 * The result's value when it has one — INCLUDING the value retained while a
 * revalidation is in flight.
 *
 * `AsyncResult.isSuccess` is false for a waiting result even when that result
 * is still carrying the data it loaded a moment ago. Reading only `isSuccess`
 * therefore turns an ordinary background refresh — an atom's time-to-live
 * lapsing, a write firing a reactivity key — into something that looks exactly
 * like a cold load, and replaces live content with a placeholder that has
 * nothing to say. Read through this instead wherever a placeholder would
 * otherwise cover data the client already has.
 */
export function asyncResultValue<A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined {
  return Option.getOrUndefined(AsyncResult.value(result));
}
