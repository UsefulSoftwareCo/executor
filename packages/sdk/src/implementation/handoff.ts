import { Effect } from "effect";

export interface Handoff<A> {
  readonly await: Effect.Effect<A>;
  readonly settle: (value: A) => Effect.Effect<boolean>;
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
