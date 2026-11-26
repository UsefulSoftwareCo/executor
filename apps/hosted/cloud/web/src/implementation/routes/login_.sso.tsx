import { CloudLoginPage } from "../pages/login.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { loginProps, loginSearch } from "@executor-js/hosted-web/pages/login";

export const Route = createFileRoute("/login_/sso")({
  codeSplitGroupings: [],
  validateSearch: loginSearch,
  component: () => <CloudLoginPage {...loginProps(Route.useSearch())} method="sso" />,
});
