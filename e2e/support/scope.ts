import { Effect } from "effect";

export type OneOf<Keys extends string, K extends Keys, V> = { readonly [P in K]: V } & {
  readonly [P in Exclude<Keys, K>]?: never;
};

export type Scope<Kinds extends Record<string, unknown>> = {
  [K in keyof Kinds & string]: OneOf<keyof Kinds & string, K, Kinds[K]>;
}[keyof Kinds & string];

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
