import { useAtomValue } from "@effect/atom-react";
import type { ProductBrand } from "@executor-js/utils/product-brand";
import { productBrandAtom } from "../../contracts/product-brand.ts";

/** The deployment's name and logo, as its document was rendered with. */
export const useProductBrand = (): ProductBrand => useAtomValue(productBrandAtom);
