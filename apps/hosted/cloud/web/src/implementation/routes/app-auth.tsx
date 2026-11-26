import { createFileRoute } from "@tanstack/react-router";
import { appUiSearch } from "@executor-js/hosted-web/contracts/app-ui";
import { AppSignInPage } from "@executor-js/hosted-web/pages/app-sign-in";

export const Route = createFileRoute("/app-auth")({
  validateSearch: appUiSearch,
  component: SignIn,
});
function SignIn() {
  const { request, failure } = Route.useSearch();
  return <AppSignInPage key={request} request={request} failure={failure} />;
}
