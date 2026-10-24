/** The catalog entry is cheap metadata; the app source loads on demand. */
import { CatalogEntry } from "@executor-js/catalog/contracts";
import type { AppCopyOrigin } from "@executor-js/sdk/core";
import { executorCatalogPackage } from "../contracts/catalog.ts";
import { defaultProductBrand, type ProductBrand } from "@executor-js/utils/product-brand";

/**
 * This installation's public API, available as a built-in app. Its name stays Executor, which
 * the installed copy and agents rely on; the dashboard shows it under the product's name.
 */
export const executorCatalogEntry = (origin: string, brand: ProductBrand = defaultProductBrand) =>
  CatalogEntry.make({
    id: `${origin}/openapi.json`,
    package: executorCatalogPackage,
    name: "Executor",
    description: `Manage apps and connected accounts in ${brand.name}.`,
    auth: [
      { method: "oauth", kind: "oauth2" },
      { method: "apiKey", kind: "secrets", label: `${brand.name} API key` },
    ],
    icons: [
      brand.logo === defaultProductBrand.logo
        ? { src: brand.logo, mimeType: "image/png" }
        : { src: brand.logo },
    ],
  });

/**
 * Every Executor app this installation creates, from the catalog or as an organization's default,
 * records this origin, so Add app recognizes it as installed.
 */
export const executorCopyOrigin = (origin: string): AppCopyOrigin => ({
  reference: executorCatalogEntry(origin).id,
  name: executorCatalogEntry(origin).package,
  commit: null,
});
