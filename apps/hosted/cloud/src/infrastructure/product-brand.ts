import { Config, Effect, Option } from "effect";

const settings = ["EXECUTOR_PRODUCT_NAME", "EXECUTOR_PRODUCT_LOGO_URL"] as const;

export const productBrandBindings = Effect.gen(function* () {
  const bindings: Partial<Record<(typeof settings)[number], string>> = {};
  for (const name of settings) {
    const value = yield* Config.NonEmptyString(name).pipe(Config.option);
    if (Option.isSome(value)) bindings[name] = value.value;
  }
  return bindings;
});
