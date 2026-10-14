/** Install the bundled management app using the same deployment and account operations as user apps. */
import { StorageError, sourceFilesEqual, type Executor } from "@executor-js/sdk/core";
import { Effect, Redacted } from "effect";
import type { SqlClient } from "effect/sql";
import { linkAccount } from "./app-accounts.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { executorAppSource } from "./executor-app-source.ts";
import { executorAppOwner as owner } from "./owners.ts";

/** Keep the host's bundled source and explicitly configured local API connection ready across restarts. */
export const installExecutorApp = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  config: ServerConfig,
) =>
  Effect.gen(function* () {
    const files = yield* executorAppSource();
    const existing = (yield* executor.apps.list({ owner, name: "Executor" }))[0];
    const current =
      existing === undefined ? undefined : yield* executor.apps.source({ owner, app: existing.id });
    const unchanged = current !== undefined && sourceFilesEqual(current.files, files);
    const app =
      existing === undefined
        ? (yield* executor.apps.deploy({ owner, name: "Executor", files })).app
        : unchanged
          ? existing
          : (yield* executor.apps.deploy({
              owner,
              app: existing.id,
              files,
            })).app;
    const requirement = app.requirements.accounts.executor;
    if (requirement === undefined) return yield* Effect.fail(new StorageError());
    // Every accepted local API caller already holds this exact key. No separate administrator key is created.
    const fields = Redacted.make({
      baseUrl: `http://127.0.0.1:${config.port}`,
      apiKey: Redacted.value(config.apiKey),
    });
    // The host's owner holds only this account.
    const [saved] = (yield* executor.accounts.list({ owner })).filter(
      (account) => account.provider === requirement.provider,
    );
    const account =
      saved !== undefined
        ? saved
        : yield* executor.managedAccounts.add({
            owner,
            provider: requirement.provider,
            method: "apiKey",
            label: "Local Executor",
            fields,
          });
    // Update the host-owned connection in place when its configured port/key changes; keep the account ID stable.
    yield* executor.managedAccounts.replaceCredentials({ owner, account: account.id, fields });
    // It is the app's one linked account; linking it again changes nothing.
    yield* linkAccount(sql, executor, {
      app: app.id,
      scope: "user",
      requirement: "executor",
      account: account.id,
    }).pipe(Effect.catchTag("RequirementMismatch", () => new StorageError()));
    return { app: app.id, account: account.id };
  });
