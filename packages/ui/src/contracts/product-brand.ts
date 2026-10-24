import {
  defaultProductBrand,
  isDefaultProductBrand,
  ProductBrand,
} from "@executor-js/utils/product-brand";
import { Atom } from "effect/reactivity";

export { isDefaultProductBrand };

/**
 * The deployment's name and logo, sent with each server-rendered document. A host that sets no
 * brand presents itself as Executor.
 */
export const productBrandAtom = Atom.make<ProductBrand>(defaultProductBrand).pipe(
  Atom.serializable({ key: "product-brand", schema: ProductBrand }),
  Atom.keepAlive,
);

/** The name as the dashboard's lowercase wordmark shows it beside the logo. */
export const productWordmark = (brand: ProductBrand) => brand.name.toLowerCase();

/** The app every organization gets, whose name and slug agents use; see `appDisplayName`. */
export const builtInApp = (app: {
  readonly name: string;
  readonly copiedFrom: { readonly name: string } | null;
}) => app.name === defaultProductBrand.name && app.copiedFrom?.name === "executor";

/**
 * The name people see for an app. The built-in app keeps the stored name Executor, which agents
 * and lookups rely on, and shows the product's name instead; a renamed copy shows its own.
 */
export const appDisplayName = (
  app: { readonly name: string; readonly copiedFrom: { readonly name: string } | null },
  brand: ProductBrand,
) => (builtInApp(app) ? brand.name : app.name);

/**
 * Where only an app's name is known, such as on an approval, the name Executor is the built-in
 * app and shows the product's name.
 */
export const productNamed = (name: string, brand: Pick<ProductBrand, "name">) =>
  name === defaultProductBrand.name ? brand.name : name;
