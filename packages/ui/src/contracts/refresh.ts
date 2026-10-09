/** Retention and revalidation for dashboard reads that also render on the server. */
import type { Duration } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";

/**
 * Counts returns to a visible page. A server render has no window, so its value never changes
 * there and each read starts once for that request.
 */
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

/** A page opened again within this time shows its retained value without another read. */
const retention: Duration.Input = "5 minutes";
/** Older retained values are shown while they are read again in the background. */
const freshness: Duration.Input = "30 seconds";

/**
 * Keep a read for a while after its last view closes, so returning to a page shows its data
 * instead of a skeleton. A page that opens with a value older than `freshness` reads it again in
 * the background, and every return to a visible tab reads it again. Hydrated values carry the
 * server's timestamp, so the first render after hydration does not repeat the server's read.
 */
export const revalidated = <A extends Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>(
  self: A,
) =>
  Atom.swr(Atom.setIdleTTL(self, retention), {
    staleTime: freshness,
    revalidateOnMount: true,
    revalidateOnFocus: "always",
    focusSignal: pageFocus,
  });
