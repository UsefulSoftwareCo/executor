import { createFileRoute } from "@tanstack/react-router";
import { parseAccountSearch } from "@executor-js/hosted-web/contracts/navigation";
import { SecurityPending } from "@executor-js/hosted-web/account";
import { SecurityPage } from "@executor-js/hosted-web/pages/security";
import { Passkeys, PasskeysPending } from "../components/passkeys.tsx";

export const Route = createFileRoute("/account/security")({
  validateSearch: parseAccountSearch,
  pendingComponent: () => (
    <SecurityPending>
      <PasskeysPending />
    </SecurityPending>
  ),
  component: () => (
    <SecurityPage>
      <Passkeys />
    </SecurityPage>
  ),
});
