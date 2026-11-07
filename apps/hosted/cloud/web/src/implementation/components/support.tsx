import type { ReactElement } from "react";
import { SupportDialog } from "@executor-js/ui/dashboard/support-dialog";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";
import { isDefaultProductBrand } from "@executor-js/ui/contracts/product-brand";
import { captureSupportLinkClicked, captureSupportOpened } from "../analytics.tsx";

/** Cloud's support entry, recording its use in product analytics. `trigger` opens it in place of
 * the sidebar entry. Its channels reach Executor's team, so a deployment under another brand
 * shows none. */
export function CloudSupport({ trigger }: { readonly trigger?: ReactElement | undefined } = {}) {
  if (!isDefaultProductBrand(useProductBrand())) return null;
  return (
    <SupportDialog
      onOpen={captureSupportOpened}
      onLinkClick={captureSupportLinkClicked}
      trigger={trigger}
    />
  );
}
