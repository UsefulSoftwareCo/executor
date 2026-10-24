/** The name and logo people see wherever a deployment presents itself. */
import { Config, Context, Effect, Schema } from "effect";

/**
 * What a deployment calls itself in its pages, emails, OAuth client metadata and MCP server
 * description. `logo` is a square image URL, absolute or a path on the deployment's own origin.
 */
export const ProductBrand = Schema.Struct({
  name: Schema.NonEmptyString,
  logo: Schema.NonEmptyString,
});
export type ProductBrand = typeof ProductBrand.Type;

export const defaultProductBrand: ProductBrand = { name: "Executor", logo: "/favicon.png" };

/**
 * Whether the deployment presents itself as Executor. Only then do Executor's published plugins
 * and the screenshots that show its name apply.
 */
export const isDefaultProductBrand = (brand: ProductBrand) =>
  brand.name === defaultProductBrand.name;

/** The name an MCP client lists this server under, such as `executor`. */
export const productServerName = (brand: ProductBrand) =>
  brand.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "executor";

/** The logo as an absolute URL, for emails and metadata read away from the deployment. */
export const productLogoUrl = (brand: ProductBrand, origin: string) =>
  new URL(brand.logo, origin).href;

/** A setting left empty or blank counts as unset. */
const setting = (name: string, fallback: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim() || fallback),
  );

/**
 * The operator's brand from `EXECUTOR_PRODUCT_NAME` and `EXECUTOR_PRODUCT_LOGO_URL`, each
 * falling back to Executor's own. A logo that is neither a URL nor a path stops startup.
 */
export const productBrandConfig = Effect.gen(function* () {
  const name = yield* setting("EXECUTOR_PRODUCT_NAME", defaultProductBrand.name);
  const logo = yield* setting("EXECUTOR_PRODUCT_LOGO_URL", defaultProductBrand.logo);
  if (URL.parse(logo, "https://origin.invalid") === null)
    return yield* Effect.die(
      new Error("EXECUTOR_PRODUCT_LOGO_URL must be an absolute URL or a path"),
    );
  return { name, logo } satisfies ProductBrand;
});

/** The brand server code presents; a host that provides none presents Executor. */
export const CurrentProductBrand = Context.Reference<ProductBrand>(
  "@executor-js/utils/CurrentProductBrand",
  { defaultValue: () => defaultProductBrand },
);
