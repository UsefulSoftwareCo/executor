import { Schema } from "effect";
import { column, idColumn, table } from "fumadb-effect/schema";
import { AccountId, OwnerId, ProviderId } from "../contracts/shared.ts";

/** Credential references stay in the account's encrypted envelope, independent of app source. */
export const accountAcquisitions = table("executor_account_acquisitions", {
  account: idColumn("account", AccountId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", ProviderId, { type: "varchar(255)" }),
  method: column("method", Schema.String, { type: "varchar(255)" }),
  driver: column("driver", Schema.String, { type: "varchar(255)" }),
  driverRevision: column("driver_revision", Schema.String, { type: "varchar(255)" }),
  generation: column("generation", Schema.Int),
  revision: column("revision", Schema.String, { type: "varchar(255)" }),
  removal: column("removal", Schema.NullOr(Schema.Json)).default(null),
});
