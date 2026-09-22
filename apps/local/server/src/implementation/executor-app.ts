/** Install the bundled management app using the same deployment and account operations as user apps. */
import {
  OwnerId,
  StorageError,
  type ExecutorDatabase,
  type Credentials,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Redacted } from "effect";
import type { ServerConfig } from "../contracts/config.ts";
import { executorAppSource } from "./executor-app-source.ts";

const owner = OwnerId.make("executor-local");

/** Keep the host's bundled source and explicitly configured local API connection ready across restarts. */
export const installExecutorApp = (
  executor: Executor,
  storage: ExecutorDatabase,
  credentials: Credentials,
  config: ServerConfig,
) =>
  Effect.gen(function* () {
    const files = yield* executorAppSource();
    const db = storage.orm("1.12.0");
    const existing = (yield* executor.apps.list({ owner, name: "Executor" }))[0];
    const current =
      existing === undefined ? undefined : yield* executor.apps.source({ owner, app: existing.id });
    const currentFiles =
      current === undefined
        ? undefined
        : new Map(current.files.map((file) => [file.path, file.content]));
    const unchanged =
      currentFiles !== undefined &&
      currentFiles.size === files.length &&
      files.every((file) => currentFiles.get(file.path) === file.content);
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
    const selected = app.accounts.executor;
    const account =
      typeof selected === "string"
        ? yield* executor.accounts.get({ account: selected })
        : yield* executor.accounts.add({
            owner,
            provider: requirement.provider,
            method: "apiKey",
            label: "Local Executor",
            fields,
          });
    if (account.provider !== requirement.provider) return yield* Effect.fail(new StorageError());
    // Update the host-owned connection in place when its configured port/key changes; keep the account ID stable.
    const encryptedCredentials = yield* credentials.encrypt(account.id, fields);
    yield* db
      .updateMany("accounts", {
        where: (b) => b("id", "=", account.id),
        set: { encryptedCredentials },
      })
      .pipe(Effect.mapError(() => new StorageError()));
    if (selected !== account.id)
      yield* executor.apps.update({ app: app.id, accounts: { executor: account.id } });
    return { app: app.id, account: account.id };
  });
