/** Correlate a committed React snapshot without modifying authored query values. */
import { Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";

/** Per-result metadata follows the exact Atom registry snapshot, including concurrent mounts. */
export interface ObservedQueryValue<A> {
  readonly value: A;
  readonly commit: () => void;
}

const commits = new WeakMap<object, () => void>();

/** Strip internal metadata at the atom boundary and retain only a weak association to its result. */
export const queryResult = <A, E>(result: AsyncResult.AsyncResult<ObservedQueryValue<A>, E>) => {
  const visible = AsyncResult.map(result, (observed) => observed.value);
  const observed = AsyncResult.value(result);
  if (Option.isSome(observed)) commits.set(visible, observed.value.commit);
  return visible;
};

/** Called after React has committed this exact result to the DOM; unrelated atoms have no callback. */
export const queryCommitted = (result: object): void => {
  commits.get(result)?.();
};
