import {
  defaultProductBrand,
  isDefaultProductBrand,
  ProductBrand,
} from "@executor-js/utils/product-brand";
import { Atom } from "effect/reactivity";

export { isDefaultProductBrand };

export const productBrandAtom = Atom.make<ProductBrand>(defaultProductBrand).pipe(
  Atom.serializable({ key: "product-brand", schema: ProductBrand }),
  Atom.keepAlive,
);

export const productWordmark = (brand: ProductBrand) => brand.name.toLowerCase();
