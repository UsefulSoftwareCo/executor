/** Optional React bindings backed by Effect Atom. No Effect imports are needed in authored components. */
import { useEffect, useLayoutEffect, useState } from "react";
import { Option } from "effect";
import { AtomRegistry, AsyncResult, type Atom } from "effect/unstable/reactivity";
import { queryCommitted } from "./implementation/query-commit.ts";

/** Subscribe for the component lifetime. Each mount owns and disposes its registry, including StrictMode remounts. */
export const useAppQuery = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => {
  const [state, setState] = useState<{
    atom: typeof atom;
    result: AsyncResult.AsyncResult<A, E>;
  }>();
  useEffect(() => {
    const registry = AtomRegistry.make();
    const stop = registry.subscribe(atom, (result) => setState({ atom, result }), {
      immediate: true,
    });
    return () => {
      stop();
      registry.dispose();
    };
  }, [atom]);
  const result = state?.atom === atom ? state.result : AsyncResult.initial<A, E>();
  useLayoutEffect(() => queryCommitted(result), [result]);
  const value = AsyncResult.value(result);
  return {
    data: Option.getOrUndefined(value),
    pending: result._tag === "Initial",
    error: result._tag === "Failure" ? "Could not load app data." : undefined,
  };
};
