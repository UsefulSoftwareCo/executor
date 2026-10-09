/** Hosted authoring uses the product's current organization authentication contract. */
import { AppIdentity, appManagementApi, frameworkApi } from "@executor-js/app-management/contracts";
import { HttpApiMiddleware } from "effect/http-api";
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
/** Framework lookups for the management app, under the same organization authorization. */
export const HostedFrameworkApi = frameworkApi("/api/organizations/:organization", HostedAppAccess);
