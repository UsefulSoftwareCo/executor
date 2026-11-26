import { AppIdentity, appManagementApi, frameworkApi } from "@executor-js/app-management/contracts";
import { HttpApiMiddleware } from "effect/http-api";
import { AuthenticationUnavailable, Forbidden, Unauthorized } from "./auth.ts";
import { OrganizationForbidden } from "./organization.ts";

export class HostedAppAccess extends HttpApiMiddleware.Service<
  HostedAppAccess,
  { provides: AppIdentity }
>()("hosted/AppAccess", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable, OrganizationForbidden],
}) {}
export const HostedAppManagementApi = appManagementApi(
  "/api/organizations/:organization",
  HostedAppAccess,
);
export const HostedFrameworkApi = frameworkApi("/api/organizations/:organization", HostedAppAccess);
