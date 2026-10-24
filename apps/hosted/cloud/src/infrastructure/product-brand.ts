/** The operator's brand reaches each Worker that presents it as plain Worker settings. */
import { productBrandSettings } from "@executor-js/utils/product-brand";
import { Config, Effect, Option } from "effect";

const settings = Object.values(productBrandSettings);

/** Only the settings the deploy sets are bound; an unset one keeps Executor's own. */
export const productBrandBindings = Effect.gen(function* () {
  const bindings: Partial<Record<(typeof settings)[number], string>> = {};
  for (const name of settings) {
    const value = yield* Config.NonEmptyString(name).pipe(Config.option);
    if (Option.isSome(value)) bindings[name] = value.value;
  }
  return bindings;
});
