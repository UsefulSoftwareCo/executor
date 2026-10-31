/** Called by the shared link boundary while its app lock is held. */
import {
  AccountProvisioned,
  StorageError,
  type AppId,
  type AccountId,
  type ProviderId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export const protectProvisionedLinks = (
  sql: SqlClient.SqlClient,
  input: {
    readonly app: AppId;
    readonly requirement: string;
    readonly account: AccountId;
    readonly subject: string | null;
    readonly provider: ProviderId;
  },
) =>
  Effect.gen(function* () {
    const links = yield* sql`select l.account from hosted_app_account_links l
    join executor_apps app on app.id = l.app
    join executor_deployments d on d.id = app.active_deployment
    join executor_accounts a on a.id = l.account
    where l.app = ${input.app} and l.requirement = ${input.requirement}
      and ${input.subject === null ? sql`l.subject is null` : sql`l.subject = ${input.subject}`}
      and l.account <> ${input.account}
      and coalesce(d.requirements::jsonb -> 'accounts' -> ${input.requirement} ->> 'cardinality', 'one') <> 'many'
      and d.requirements::jsonb -> 'accounts' -> ${input.requirement} -> 'definition' -> 'auth' -> a.method ->> 'provisioned' = 'true'`;
    if (links.length > 0) return yield* new AccountProvisioned({ provider: input.provider });
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));
