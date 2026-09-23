import type { DashboardError } from "./errors.ts";
/** Local app actions reuse the dashboard's authenticated typed client. */
import { makeAppManagementAtoms } from "@executor-js/ui/contracts/app-management";
import { Effect } from "effect";
import { DashboardClient } from "./api.ts";
export const appManagement = makeAppManagementAtoms<DashboardClient, DashboardError>(
  DashboardClient.runtime,
  Effect.map(DashboardClient, (client) => client.appManagement),
  {},
);
