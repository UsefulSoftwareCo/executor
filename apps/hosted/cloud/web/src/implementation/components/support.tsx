import type { ReactElement } from "react";
import { SupportDialog } from "@executor-js/ui/dashboard/support-dialog";
import { captureSupportLinkClicked, captureSupportOpened } from "../analytics.tsx";

export function CloudSupport({ trigger }: { readonly trigger?: ReactElement | undefined } = {}) {
  return (
    <SupportDialog
      onOpen={captureSupportOpened}
      onLinkClick={captureSupportLinkClicked}
      trigger={trigger}
    />
  );
}
