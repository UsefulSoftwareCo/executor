import { hydrated } from "@executor-js/ui/contracts/http";
import { DashboardClient } from "./api.ts";

export const ownerMigrationAtom = DashboardClient.query(
  "dashboard",
  "ownerMigration",
  hydrated({}),
);
