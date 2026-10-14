import type { ReactElement } from "react";
import { SupportDialog } from "@executor-js/ui/dashboard/support-dialog";
import { captureSupportLinkClicked, captureSupportOpened } from "../analytics.tsx";

/** Cloud's support entry, recording its use in product analytics. `trigger` opens it in place of
 * the sidebar entry. */
export function CloudSupport({ trigger }: { readonly trigger?: ReactElement | undefined } = {}) {
  return (
    <SupportDialog
      onOpen={captureSupportOpened}
      onLinkClick={captureSupportLinkClicked}
      trigger={trigger}
    />
  );
}
