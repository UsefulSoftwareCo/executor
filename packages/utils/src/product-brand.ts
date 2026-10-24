/** The name and logo people see wherever a deployment presents itself. */
import { Config, Context, Effect, Schema } from "effect";

/**
 * What a deployment calls itself in its pages, emails, OAuth client metadata and MCP server
 * description. `logo` is a square image URL, absolute or a path on the deployment's own origin.
 * `docs`, `privacy` and `terms` are the deployment's own pages behind those links.
 */
export const ProductBrand = Schema.Struct({
  name: Schema.NonEmptyString,
  logo: Schema.NonEmptyString,
  docs: Schema.optional(Schema.NonEmptyString),
  privacy: Schema.optional(Schema.NonEmptyString),
  terms: Schema.optional(Schema.NonEmptyString),
});
export type ProductBrand = typeof ProductBrand.Type;

export const defaultProductBrand: ProductBrand = { name: "Executor", logo: "/favicon.png" };

/**
 * Whether the deployment presents itself as Executor. Only then do Executor's published plugins
 * and the screenshots that show its name apply.
 */
export const isDefaultProductBrand = (brand: ProductBrand) =>
  brand.name === defaultProductBrand.name;

/**
 * The deployment's own docs or legal page when it names one. Executor's own `fallback` applies
 * only while the deployment presents Executor; under another name an unset link is not shown.
 */
export const productLink = (
  brand: ProductBrand,
  link: "docs" | "privacy" | "terms",
  fallback: string,
): string | undefined => brand[link] ?? (isDefaultProductBrand(brand) ? fallback : undefined);

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
const setting = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim() || undefined),
  );

/** An absolute http(s) URL, or a path on this origin starting with `/`. */
const isUrlOrPath = (value: string) => {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  const url = URL.parse(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:");
};

const urlOrPath = (name: string, value: string | undefined) =>
  value === undefined || isUrlOrPath(value)
    ? Effect.succeed(value)
    : Effect.die(new Error(`${name} must be an absolute http(s) URL or a path starting with /`));

/** The settings a host reads its brand from; every one is optional. */
export const productBrandSettings = {
  name: "EXECUTOR_PRODUCT_NAME",
  logo: "EXECUTOR_PRODUCT_LOGO_URL",
  docs: "EXECUTOR_PRODUCT_DOCS_URL",
  privacy: "EXECUTOR_PRODUCT_PRIVACY_URL",
  terms: "EXECUTOR_PRODUCT_TERMS_URL",
} as const;

/**
 * The operator's brand from `productBrandSettings`, the name and logo falling back to Executor's
 * own. A logo or link that is neither an http(s) URL nor a `/` path stops startup.
 */
export const productBrandConfig = Effect.gen(function* () {
  const name = (yield* setting(productBrandSettings.name)) ?? defaultProductBrand.name;
  const logo = yield* urlOrPath(
    productBrandSettings.logo,
    (yield* setting(productBrandSettings.logo)) ?? defaultProductBrand.logo,
  );
  const links: { docs?: string; privacy?: string; terms?: string } = {};
  for (const link of ["docs", "privacy", "terms"] as const) {
    const value = yield* urlOrPath(
      productBrandSettings[link],
      yield* setting(productBrandSettings[link]),
    );
    if (value !== undefined) links[link] = value;
  }
  return { name, logo: logo ?? defaultProductBrand.logo, ...links } satisfies ProductBrand;
});

/** The brand server code presents; a host that provides none presents Executor. */
export const CurrentProductBrand = Context.Reference<ProductBrand>(
  "@executor-js/utils/CurrentProductBrand",
  { defaultValue: () => defaultProductBrand },
);
