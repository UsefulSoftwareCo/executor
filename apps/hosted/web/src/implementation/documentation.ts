/** Documentation links resolved against the documentation base the server sent with this page. */
import { useAtomValue } from "@effect/atom-react";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";
import { productLink } from "@executor-js/utils/product-brand";
import { documentationBaseAtom, documentationPage } from "../contracts/documentation.ts";

/**
 * The absolute URL of a documentation page; the empty path is the documentation index. A
 * deployment's own docs get only an index link, used as given, since their pages are its own;
 * under another name without docs of its own, every documentation link is undefined.
 */
export const useDocumentationUrl = (path = ""): string | undefined => {
  const brand = useProductBrand();
  const base = useAtomValue(documentationBaseAtom);
  if (brand.docs !== undefined) return path === "" ? brand.docs : undefined;
  const fallback = productLink(brand, "docs", base);
  return fallback === undefined ? undefined : documentationPage(fallback, path);
};
