/** Hosted authoring uses the product's current organization authentication contract. */
import { AppIdentity, appManagementApi } from "@executor-js/app-management/contracts";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { AuthenticationUnavailable, Forbidden, Unauthorized } from "./auth.ts";
import { OrganizationForbidden } from "./organization.ts";

/** Resolve app identity after the existing organization middleware checks the request. */
export class HostedAppAccess extends HttpApiMiddleware.Service<
  HostedAppAccess,
  { provides: AppIdentity }
>()("hosted/AppAccess", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable, OrganizationForbidden],
}) {}
/** Browser and agent clients consume the same product-authorized app API. */
export const HostedAppManagementApi = appManagementApi(
  "/api/organizations/:organization",
  HostedAppAccess,
);
