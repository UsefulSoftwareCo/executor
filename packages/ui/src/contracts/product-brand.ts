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
