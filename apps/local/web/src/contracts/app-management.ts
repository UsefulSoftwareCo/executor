import type { DashboardError } from "./errors.ts";
import { makeAppManagementAtoms } from "@executor-js/ui/contracts/app-management";
import { Effect } from "effect";
import { DashboardClient } from "./api.ts";
export const appManagement = makeAppManagementAtoms<DashboardClient, DashboardError>(
  DashboardClient.runtime,
  Effect.map(DashboardClient, (client) => client.appManagement),
  {},
);
