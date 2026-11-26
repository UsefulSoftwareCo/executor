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

export type NameVariantsBuilder<Schemas extends ReadonlyArray<AnySchema>, Out> = {
  (variants: BuildNameVariants<Schemas[number]["tables"]>): Out;
  <Version extends Schemas[number]["version"]>(
    versions: ReadonlyArray<Version>,
    variants: BuildNameVariants<Extract<Schemas[number], { version: Version }>["tables"]>,
  ): Out;
  readonly prefix: (prefix: true | string) => Out;
};

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
