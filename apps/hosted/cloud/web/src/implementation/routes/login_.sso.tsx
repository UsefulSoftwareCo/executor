import { CloudLoginPage } from "../pages/login.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { loginSearch } from "@executor-js/hosted-web/pages/login";

/** Work-email discovery has its own document and keeps the original return path. */
export const Route = createFileRoute("/login_/sso")({
  codeSplitGroupings: [],
  validateSearch: loginSearch,
  component: () => <CloudLoginPage {...Route.useSearch()} method="sso" />,
});
