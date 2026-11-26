import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AccountPending, AccountShell } from "@executor-js/hosted-web/account";
import { ChangePasswordPending } from "../components/change-password.tsx";

export const Route = createFileRoute("/account")({
  component: () => (
    <AccountShell>
      <Outlet />
    </AccountShell>
  ),
  pendingComponent: () => <AccountPending security={<ChangePasswordPending />} />,
});
