import { Schema } from "effect";
import { column, idColumn, table } from "fumadb-effect/schema";
import { AccountCheckStatus } from "../contracts/account.ts";
import { AccountId, OwnerId } from "../contracts/shared.ts";
import { ProviderError } from "apps/contracts";

/** One bound driver per saved account. App checks keep their existing independent rows. */
export const accountDriverChecks = table("executor_account_driver_checks", {
  account: idColumn("account", AccountId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  driver: column("driver", Schema.String, { type: "varchar(255)" }),
  driverRevision: column("driver_revision", Schema.String, { type: "varchar(255)" }),
  bindingRevision: column("binding_revision", Schema.String, { type: "varchar(255)" }),
  generation: column("generation", Schema.Int),
  checkable: column("checkable", Schema.Boolean),
  status: column("status", Schema.NullOr(AccountCheckStatus)),
  reason: column("reason", Schema.NullOr(ProviderError.fields.reason), { type: "varchar(255)" }),
  checkedAt: column("checked_at", Schema.Date),
  info: column("info", Schema.NullOr(Schema.Json)).default(null),
  infoCheckedAt: column("info_checked_at", Schema.NullOr(Schema.Date)).default(null),
  message: column("message", Schema.NullOr(Schema.String)).default(null),
});
