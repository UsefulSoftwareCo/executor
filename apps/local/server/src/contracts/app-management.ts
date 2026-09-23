/** Local app authoring preserves the dashboard pairing and storage error contract. */
import { AppIdentity, appManagementApi } from "@executor-js/app-management/contracts";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { DashboardForbidden, DashboardUnauthorized } from "./dashboard.ts";
import { AuthStorageError } from "./auth.ts";

/** Adapt an authenticated local dashboard request into an app owner. */
export class LocalAppAccess extends HttpApiMiddleware.Service<
  LocalAppAccess,
  { provides: AppIdentity }
>()("local/AppAccess", {
  error: [DashboardUnauthorized, DashboardForbidden, AuthStorageError],
}) {}
/** Shared browser and agent authoring contract for the local product. */
export const LocalAppManagementApi = appManagementApi("/api", LocalAppAccess);
