import type { ReactNode } from "react";
import { useAtomMount } from "@effect/atom-react";
import { inventoryAtom } from "../../contracts/organization.ts";
import { OrganizationContent, useOrganizationRoute } from "../components/organization.tsx";
import { SetupPage } from "../components/setup-page.tsx";
import { NameAccountDialog } from "./name-account-dialog.tsx";

export function OrganizationSetup({ children }: { readonly children: ReactNode }) {
  useAtomMount(inventoryAtom(useOrganizationRoute().organization));
  return (
    <OrganizationContent pending={<SetupPage />}>
      {children}
      <NameAccountDialog />
    </OrganizationContent>
  );
}
