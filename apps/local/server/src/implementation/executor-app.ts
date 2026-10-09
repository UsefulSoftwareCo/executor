/** Install the bundled management app using the same deployment and account operations as user apps. */
import { OwnerId, StorageError, type Executor } from "@executor-js/sdk/core";
import { Effect, Redacted } from "effect";
import type { ServerConfig } from "../contracts/config.ts";
import { executorAppSource } from "./executor-app-source.ts";

const owner = OwnerId.make("executor-local");

/** Keep the host's bundled source and explicitly configured local API connection ready across restarts. */
export const installExecutorApp = (executor: Executor, config: ServerConfig) =>
  Effect.gen(function* () {
    const files = yield* executorAppSource();
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
    const profile =
      (yield* executor.apps.profiles.list({
        app: app.id,
        owner,
        subject: "local",
        idempotencyKey: "executor-default",
      }))[0] ?? null;
    // The immutable creation request retains the host-owned account even after a user clears its selection.
    const selected = profile === null ? undefined : profile.request.accounts.executor;
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
    yield* executor.accounts.replaceCredentials({ owner, account: account.id, fields });
    const saved =
      profile === null
        ? yield* executor.apps.profiles.create({
            app: app.id,
            owner,
            subject: "local",
            idempotencyKey: "executor-default",
            accounts: { executor: account.id },
          })
        : profile;
    return { app: app.id, account: account.id, profile: saved.id };
  });
