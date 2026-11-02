import type { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
/** Product authority and plain-slot replacement around the SDK's durable retirement claims. */
import {
  InteractiveHost,
  StorageError,
  AccountId,
  type AppId,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { currentOwner } from "./access.ts";
import { lockedChange } from "./app-accounts.ts";
import { requireAccountAccess } from "./resource-policy.ts";
export const canDeleteAccount = (account: AccountId) =>
  requireAccountAccess(account, "manage").pipe(
    Effect.as(true),
    Effect.catchTag("OrganizationForbidden", () => Effect.succeed(false)),
  );
const Row = Schema.Struct({ account: AccountId });
export const replacingAccounts = <A, E, R>(
  executor: Executor,
  input: {
    readonly app: AppId;
    readonly requirement: string;
    readonly subject: string | null;
    readonly account?: AccountId;
  },
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner.pipe(Effect.mapError(() => new StorageError()));
    const retiring = yield* lockedChange(
      executor,
      { app: input.app, access: input.subject === null ? "manage" : "use" },
      (sql) =>
        Effect.gen(function* () {
          const rows = yield* sql`select l.account from hosted_app_account_links l
      join executor_apps a on a.id = l.app join executor_deployments d on d.id = a.active_deployment
      where l.app = ${input.app} and l.requirement = ${input.requirement}
      and ${input.subject === null ? sql`l.subject is null` : sql`l.subject = ${input.subject}`}
      and ${input.account === undefined ? sql`true` : sql`l.account <> ${input.account}`}
      and d.requirements::jsonb -> 'accounts' -> ${input.requirement} ->> 'cardinality' <> 'many'`;
          const accounts: AccountId[] = [];
          for (const row of yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows)) {
            const account = row.account;
            if (
              (yield* executor[InteractiveHost].binding({ owner, account }))?.app === input.app &&
              (yield* canDeleteAccount(account))
            )
              accounts.push(account);
          }
          return accounts;
        }),
    ).pipe(Effect.mapError(() => new StorageError()));
    return yield* executor[InteractiveHost].retire({ owner, accounts: retiring }, action);
  });

/** Same personal/shared management rule as the normal account deletion API, read in this transaction. */
export const canDeleteAccountWithSql = (sql: SqlClient.SqlClient, account: AccountId) =>
  Effect.gen(function* () {
    const user = yield* CurrentUserId;
    const rows =
      yield* sql`select p.account_id from hosted_account_access p join member m on m."organizationId" = p.organization_id and m."userId" = ${user ?? ""}
    where p.account_id = ${account} and ((p.kind = 'personal' and p.personal_user_id = m."userId") or (p.kind = 'shared' and (p.creator_id = m."userId" or m.role in ('owner','admin'))))`;
    return rows.length === 1;
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));
