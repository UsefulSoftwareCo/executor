/**
 * Hosted's part of data step `10_profile_app_copies`: a copy is shared exactly as its app is, and
 * links the accounts of the profiles it replaces for their member only.
 */
import type { ProfileAppCopiesHost } from "@executor-js/app-management/data-steps";
import {
  StorageError,
  StorageHost,
  WebhookSourceConfig,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { copiedAppCreation } from "./resource-lifecycle.ts";

export const hostedAppCopies = (executor: Executor): ProfileAppCopiesHost["appCopies"] => ({
  copy: ({ from, id, name, save }) =>
    executor.apps
      .copyAs({ from: from.id, owner: from.owner, name, id, save })
      .pipe(copiedAppCreation(from.id)),
  link: ({ app, subject, links, webhookConfig }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = Schema.decodeUnknownOption(WebhookSourceConfig)(webhookConfig);
      yield* executor[StorageHost].transaction(
        Effect.gen(function* () {
          // The lock links take; webhook source changes take it too.
          yield* sql`select id from executor_apps where id = ${app} for no key update`;
          for (const [index, { requirement, account }] of links.entries()) {
            // As step 9: only existing accounts of the app's owner, for an existing user. Links
            // keep the profiles' order.
            const inserted = yield* sql`insert into hosted_app_account_links
                (app, requirement, subject, account, linked_by, created_at)
              select ${app}, ${requirement}, u.id, a.id, u.id,
                  now() + ${index} * interval '1 millisecond'
                from executor_accounts a
                join executor_apps copy on copy.id = ${app} and copy.owner = a.owner
                join "user" u on u.id = ${subject}
                where a.id = ${account}
              on conflict do nothing returning account`;
            if (inserted.length === 0) continue;
            const sources = yield* executor.webhooks
              .sources({ app })
              .pipe(Effect.mapError(() => new StorageError()));
            if (!sources.some((source) => source.account === account))
              yield* executor.webhooks
                .link({
                  app,
                  account,
                  actor: subject,
                  ...(config._tag === "Some" ? { config: config.value } : {}),
                })
                .pipe(Effect.mapError(() => new StorageError()));
          }
        }),
      );
    }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
});
