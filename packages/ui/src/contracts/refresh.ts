import type { Duration } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";

const pageFocus = Atom.readable((get) => {
  if (typeof window === "undefined") return 0;
  let count = 0;
  const update = () => {
    if (document.visibilityState === "visible") get.setSelf(++count);
  };
  window.addEventListener("visibilitychange", update);
  get.addFinalizer(() => window.removeEventListener("visibilitychange", update));
  return count;
});

const retention: Duration.Input = "30 minutes";
const freshness: Duration.Input = "30 seconds";

export const revalidated = <A extends Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>(
  self: A,
) =>
  Atom.swr(Atom.setIdleTTL(self, retention), {
    staleTime: freshness,
    revalidateOnMount: true,
    revalidateOnFocus: "always",
    focusSignal: pageFocus,
  });

export const refreshedOnFocus = Atom.makeRefreshOnSignal(pageFocus);
