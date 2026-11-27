import { AppIdentity, appManagementApi, frameworkApi } from "@executor-js/app-management/contracts";
import { HttpApiMiddleware } from "effect/http-api";
import { DashboardForbidden, DashboardUnauthorized } from "./dashboard.ts";
import { AuthStorageError } from "./auth.ts";

export class LocalAppAccess extends HttpApiMiddleware.Service<
  LocalAppAccess,
  { provides: AppIdentity }
>()("local/AppAccess", {
  error: [DashboardUnauthorized, DashboardForbidden, AuthStorageError],
}) {}
export const LocalAppManagementApi = appManagementApi("/api", LocalAppAccess);
export const LocalFrameworkApi = frameworkApi("/api", LocalAppAccess);
