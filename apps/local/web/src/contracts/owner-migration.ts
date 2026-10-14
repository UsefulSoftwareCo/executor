import { hydrated } from "@executor-js/ui/contracts/http";
import { DashboardClient } from "./api.ts";

/** Why this start did not move other owners' records to `local`; fixed until the next start. */
export const ownerMigrationAtom = DashboardClient.query(
  "dashboard",
  "ownerMigration",
  hydrated({}),
);
