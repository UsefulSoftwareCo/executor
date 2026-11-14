import { createFileRoute } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { parseAccountSearch } from "@executor-js/hosted-web/contracts/navigation";
import { SecurityPending } from "@executor-js/hosted-web/account";
import { SecurityPage } from "@executor-js/hosted-web/pages/security";
import { ChangePassword, ChangePasswordPending } from "../components/change-password.tsx";
import { ConnectSso } from "../components/connect-sso.tsx";

/**
 * Self-host signs in with a password (or SSO); the password is changed and SSO connected here. A
 * refused SSO connection returns with its `error` code.
 */
export const Route = createFileRoute("/account/security")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...parseAccountSearch(search),
    error: Option.getOrUndefined(Schema.decodeUnknownOption(Schema.NonEmptyString)(search.error)),
  }),
  pendingComponent: () => (
    <SecurityPending>
      <ChangePasswordPending />
    </SecurityPending>
  ),
  component: () => (
    <SecurityPage>
      <ChangePassword />
      <ConnectSso refused={Route.useSearch().error} />
    </SecurityPage>
  ),
});
