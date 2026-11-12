/**
 * A scope names what a scenario owns, so a telemetry read returns only its own data. A scope is
 * one kind, such as `{ app }` or `{ traces }`, never two. A scope whose ID is missing or empty, or
 * whose trace list is empty, would read nothing or everything without saying so, so it is a defect.
 */
import { Effect } from "effect";

/** Exactly one of `Keys`, `K`, with a value of type `V`; naming any other key does not typecheck. */
export type OneOf<Keys extends string, K extends Keys, V> = { readonly [P in K]: V } & {
  readonly [P in Exclude<Keys, K>]?: never;
};

/** A scope with each of `Kinds` as a kind of its own, of the given value types. */
export type Scope<Kinds extends Record<string, unknown>> = {
  [K in keyof Kinds & string]: OneOf<keyof Kinds & string, K, Kinds[K]>;
}[keyof Kinds & string];

/** The scope's one kind and value, or a defect naming the reader and what is wrong. */
export const scopeOf = <S extends object>(
  reader: string,
  scope: S,
): Effect.Effect<{ readonly kind: string; readonly value: string | ReadonlyArray<string> }> => {
  const set = Object.entries(scope).filter(([, value]) => value !== undefined);
  if (set.length !== 1)
    return Effect.die(
      new Error(
        `${reader} needs exactly one scope; it was given ${set.length === 0 ? "none" : set.map(([kind]) => kind).join(" and ")}`,
      ),
    );
  const [kind, value] = set[0]!;
  if (typeof value === "string")
    return value === ""
      ? Effect.die(new Error(`${reader} was given an empty ${kind}`))
      : Effect.succeed({ kind, value });
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value.length === 0 || value.includes("")
      ? Effect.die(
          new Error(`${reader} was given ${value.length === 0 ? "no" : "an empty"} ${kind}`),
        )
      : Effect.succeed({ kind, value: value as ReadonlyArray<string> });
  return Effect.die(new Error(`${reader} was given a ${kind} that is not an ID`));
};
