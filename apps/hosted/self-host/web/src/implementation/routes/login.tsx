import { SelfHostLoginPage } from "../pages/login.tsx";
import { SelfHostLoginPending } from "../components/login-pending.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { loginProps, loginSearch } from "@executor-js/hosted-web/pages/login";

export const Route = createFileRoute("/login")({
  validateSearch: loginSearch,
  component: () => <SelfHostLoginPage {...loginProps(Route.useSearch())} />,
  pendingComponent: SelfHostLoginPending,
});
