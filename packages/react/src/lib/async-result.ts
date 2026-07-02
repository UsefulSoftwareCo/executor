import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

export function isAsyncResultLoading<A, E>(result: AsyncResult.AsyncResult<A, E>): boolean {
  return AsyncResult.isInitial(result) || AsyncResult.isWaiting(result);
}
