import { useAtomValue } from "@effect/atom-react";
import type { ProductBrand } from "@executor-js/utils/product-brand";
import { productBrandAtom } from "../../contracts/product-brand.ts";

export const useProductBrand = (): ProductBrand => useAtomValue(productBrandAtom);
