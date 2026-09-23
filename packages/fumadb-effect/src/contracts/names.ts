/**
 * Consumer-side name overrides on a factory.
 */
import type { AnySchema } from "./schema/schema.ts";
import type { AnyTable } from "./schema/table.ts";
import {
  applyNameVariants,
  applyNameVariantsPrefix,
  type NameVariants,
  type NameVariantsConfig,
} from "./schema/names.ts";

type BuildNameVariants<Tables extends Record<string, AnyTable>> = {
  readonly [
    K in keyof Tables as K extends string
      ? keyof Tables[K]["columns"] extends string
        ? `${K}.${keyof Tables[K]["columns"]}`
        : never
      : never
  ]?: Partial<NameVariants>;
} & { readonly [K in keyof Tables]?: Partial<NameVariants> };

/** The `names` API of a factory: override SQL names, or prefix every table. Each call returns a new factory. */
export type NameVariantsBuilder<Schemas extends ReadonlyArray<AnySchema>, Out> = {
  /** Override names in every schema version. */
  (variants: BuildNameVariants<Schemas[number]["tables"]>): Out;
  /** Override names in the listed versions only. */
  <Version extends Schemas[number]["version"]>(
    versions: ReadonlyArray<Version>,
    variants: BuildNameVariants<Extract<Schemas[number], { version: Version }>["tables"]>,
  ): Out;
  /**
   * Prefix every table's SQL name. The prefix is concatenated verbatim (include
   * your own separator, e.g. `"chat_"`); `true` uses the bare library namespace.
   */
  readonly prefix: (prefix: true | string) => Out;
};

/**
 * Build the `names` API for a set of schemas.
 *
 * `out` receives the updated schemas; the input schemas are never modified.
 */
export const createNameVariantsBuilder = <Schemas extends ReadonlyArray<AnySchema>, Out>(
  namespace: string,
  schemas: Schemas,
  out: (schemas: Schemas) => Out,
): NameVariantsBuilder<Schemas, Out> => {
  const names = ((...args: [NameVariantsConfig] | [ReadonlyArray<string>, NameVariantsConfig]) => {
    let updated: ReadonlyArray<AnySchema>;
    if (args.length === 2) {
      const [versions, variants] = args;
      updated = schemas.map((s) =>
        versions.includes(s.version) ? applyNameVariants(s, variants) : s,
      );
    } else {
      const [variants] = args;
      updated = schemas.map((s) => applyNameVariants(s, variants));
    }
    return out(updated as unknown as Schemas);
  }) as NameVariantsBuilder<Schemas, Out>;
  (names as { prefix: NameVariantsBuilder<Schemas, Out>["prefix"] }).prefix = (prefix) => {
    const value = prefix === true ? namespace : prefix;
    return out(schemas.map((s) => applyNameVariantsPrefix(s, value)) as unknown as Schemas);
  };
  return names;
};
