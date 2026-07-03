import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Option from "effect/Option";

export function isAsyncResultLoading<A, E>(result: AsyncResult.AsyncResult<A, E>): boolean {
  return (
    AsyncResult.isInitial(result) ||
    (AsyncResult.isWaiting(result) && Option.isNone(AsyncResult.value(result)))
  );
}
