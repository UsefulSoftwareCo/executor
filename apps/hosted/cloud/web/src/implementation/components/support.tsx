import type { ReactElement } from "react";
import { SupportDialog } from "@executor-js/ui/dashboard/support-dialog";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";
import { isDefaultProductBrand } from "@executor-js/ui/contracts/product-brand";
import { captureSupportLinkClicked, captureSupportOpened } from "../analytics.tsx";

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
