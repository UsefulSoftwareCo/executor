/** Poll only while a view is mounted; query refresh and mutation acknowledgement remain on the source atom. */
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

/** Small dashboard queues refresh without manual refresh controls or a new server subscription protocol. */
export const pollingQuery = <A>(source: Atom.Atom<A>, milliseconds = 5000): Atom.Atom<A> =>
  Atom.readable(
    (get) => {
      get.addFinalizer(
        Effect.runCallback(
          Effect.forever(
            Effect.sleep(milliseconds).pipe(
              Effect.andThen(() => Effect.sync(() => get.refresh(source))),
            ),
          ),
        ),
      );
      return get(source);
    },
    (refresh) => refresh(source),
  );
