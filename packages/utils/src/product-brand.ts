import { Config, Context, Effect, Schema } from "effect";

export const ProductBrand = Schema.Struct({
  name: Schema.NonEmptyString,
  logo: Schema.NonEmptyString,
});
export type ProductBrand = typeof ProductBrand.Type;

export const defaultProductBrand: ProductBrand = { name: "Executor", logo: "/favicon.png" };

export const isDefaultProductBrand = (brand: ProductBrand) =>
  brand.name === defaultProductBrand.name;

export const productServerName = (brand: ProductBrand) =>
  brand.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "executor";

export const productLogoUrl = (brand: ProductBrand, origin: string) =>
  new URL(brand.logo, origin).href;

const setting = (name: string, fallback: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim() || fallback),
  );

export const productBrandConfig = Effect.gen(function* () {
  const name = yield* setting("EXECUTOR_PRODUCT_NAME", defaultProductBrand.name);
  const logo = yield* setting("EXECUTOR_PRODUCT_LOGO_URL", defaultProductBrand.logo);
  if (URL.parse(logo, "https://origin.invalid") === null)
    return yield* Effect.die(
      new Error("EXECUTOR_PRODUCT_LOGO_URL must be an absolute URL or a path"),
    );
  return { name, logo } satisfies ProductBrand;
});

export const CurrentProductBrand = Context.Reference<ProductBrand>(
  "@executor-js/utils/CurrentProductBrand",
  { defaultValue: () => defaultProductBrand },
);
