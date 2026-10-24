import { createFileRoute } from "@tanstack/react-router";
import { parseAccountSearch } from "@executor-js/hosted-web/contracts/navigation";
import { SecurityPending } from "@executor-js/hosted-web/account";
import { SecurityPage } from "@executor-js/hosted-web/pages/security";
import { ChangePassword, ChangePasswordPending, ConnectSso } from "../components/change-password.tsx";

/** Self-host signs in with a password (or SSO); the password is changed here. */
export const Route = createFileRoute("/account/security")({
  validateSearch: parseAccountSearch,
  pendingComponent: () => (
    <SecurityPending>
      <ChangePasswordPending />
    </SecurityPending>
  ),
  component: () => (
    <SecurityPage>
      <ChangePassword />
      <ConnectSso />
    </SecurityPage>
  ),
});
