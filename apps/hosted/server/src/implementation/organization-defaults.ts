import { organizationAppCreation, personalAccountCreation } from "./resource-lifecycle.ts";
import type { HostedApiDocument } from "../contracts/api.ts";
import { managedAccountKey } from "./api-keys.ts";
import { sourceFilesEqual } from "@executor-js/sdk/core";
import {
  AccountId,
  AppId,
  DeploymentId,
  StorageError,
  type Executor,
  type ExecutorDatabase,
  type SourceFile,
} from "@executor-js/sdk/core";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  OrganizationDefaults,
  OrganizationDefaultsPending,
} from "../contracts/organization-defaults.ts";
import { organizationOwner } from "../contracts/organization.ts";

/** Only a new or changed installation generates the Executor app, so its OpenAPI compiler loads then. */
const executorApp = Effect.promise(() => import("./executor-app.ts"));

const State = Schema.Struct({
  initialized: Schema.Boolean,
  app: Schema.NullOr(AppId),
  deployment: Schema.NullOr(DeploymentId),
  accounts: Schema.Record(Schema.String, AccountId),
});
const Accounts = Schema.Struct({ accounts: Schema.Record(Schema.String, AccountId) });

/** Install once, then create missing user accounts or repair automatic selections. Completed setup is read-only. */
export const organizationDefaults = (
  executor: Executor,
  origin: string,
  storage: ExecutorDatabase,
  skills: readonly SourceFile[],
  document: Effect.Effect<HostedApiDocument>,
  requireVerifiedEmail = true,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationDefaults.of((organization, user) =>
      Effect.gen(function* () {
        const rows = yield* sql`select
          coalesce((metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false) as initialized,
          metadata::jsonb -> 'executorDefaults' ->> 'app' as app,
          metadata::jsonb -> 'executorDefaults' ->> 'deployment' as deployment,
          coalesce(metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb) as accounts
          from "organization" where id = ${organization}`.pipe(
          Effect.mapError(() => new StorageError()),
        );
        if (rows.length !== 1) return;
        const state = yield* Schema.decodeUnknownEffect(State)(rows[0]).pipe(
          Effect.mapError(() => new StorageError()),
        );
        if (state.initialized && user === undefined) return;
        if (!state.initialized && user !== undefined)
          return yield* new OrganizationDefaultsPending();
        const owner = organizationOwner(organization);
        if (!state.initialized) {
          const { defaultExecutorAppSource } = yield* executorApp;
          const source = yield* defaultExecutorAppSource(origin, skills, yield* document);
          const existing = (yield* executor.apps.list({ owner, name: "Executor" }))[0];
          if (existing === undefined) {
            yield* executor.apps.deploy({ owner, name: "Executor", files: source.files }).pipe(
              organizationAppCreation,
              Effect.catchTags({
                AppNameTaken: () => Effect.void,
                AppSlugTaken: () => Effect.void,
              }),
            );
          }
          const installed = (yield* executor.apps.list({ owner, name: "Executor" }))[0];
          if (installed === undefined) return yield* new StorageError();
          const installedSource = yield* executor.apps.source({ owner, app: installed.id });
          const approved = sourceFilesEqual(installedSource.files, source.files)
            ? installedSource.id
            : null;
          yield* sql`update "organization" set metadata = jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorDefaults}',
            jsonb_build_object('installed', true, 'app', ${installed.id}::text, 'deployment', ${approved}::text)
          )::text where id = ${organization}`.pipe(Effect.mapError(() => new StorageError()));
        }
        if (user === undefined) return;
        // The stored ID follows renames; deletion never recreates an initialized app.
        const app =
          state.app === null
            ? (yield* executor.apps.list({ owner, name: "Executor" }))[0]
            : yield* executor.apps
                .get({ owner, app: state.app })
                .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
        if (app === undefined) return;
        let current = app;
        // The recorded deployment is immutable. Recheck source only after it changes.
        if (state.deployment !== app.activeDeployment) {
          const deployment = yield* executor.apps.source({ owner, app: app.id });
          if (deployment.id !== app.activeDeployment) return;
          const { defaultExecutorAppSource, executorAppSource } = yield* executorApp;
          const source = yield* defaultExecutorAppSource(origin, skills, yield* document);
          if (!sourceFilesEqual(deployment.files, source.files)) {
            // Upgrade only the untouched, unconfigured catalog version. Preserve user edits and connections.
            const catalog = yield* executorAppSource(origin, skills, yield* document);
            if (!sourceFilesEqual(deployment.files, catalog.files)) return;
            const workspace = yield* executor.apps.workspace({ owner, app: app.id });
            if (!sourceFilesEqual(workspace.files, deployment.files)) return;
            current = (yield* executor.apps.deploy({
              owner,
              app: app.id,
              files: source.files,
            })).app;
          }
        }
        const requirement = current.requirements.accounts.service;
        if (requirement === undefined) return yield* new StorageError();
        const savedAccount = (accounts: Readonly<Record<string, AccountId>>) => {
          const id = Object.hasOwn(accounts, user.userId) ? accounts[user.userId] : undefined;
          return id === undefined
            ? Effect.succeed(undefined)
            : executor.accounts
                .get({ owner, account: id })
                .pipe(Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)));
        };
        const existingProfile = yield* storage
          .orm("4.0.0")
          .findFirst("profiles", {
            where: (b) =>
              b.and(
                b("app", "=", app.id),
                b("subject", "=", user.userId),
                b("idempotencyKey", "=", "executor-default"),
              ),
          })
          .pipe(Effect.mapError(() => new StorageError()));
        const saved = yield* savedAccount(state.accounts);
        // A recorded account that was deliberately deleted is not a new-user setup.
        // Keep that intent: inventory reads must not recreate credentials or choose a replacement.
        if (Object.hasOwn(state.accounts, user.userId) && saved === undefined) return;
        if (
          saved !== undefined &&
          (saved.provider !== requirement.provider || saved.method !== "apiKey")
        )
          return yield* new StorageError();
        // Existing saved accounts keep their credential; setup does not mint replacement keys.
        // Read current SQL metadata on every call; this is not an isolate-local result cache.
        if (
          state.deployment === current.activeDeployment &&
          saved !== undefined &&
          existingProfile !== null
        )
          return;
        // Build/network work finished above. Only account creation or selection repair needs the lock.
        yield* storage
          .orm("4.0.0")
          .transaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`select coalesce(metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb) as accounts
            from "organization" where id = ${organization} for update`.pipe(
                  Effect.mapError(() => new StorageError()),
                );
              if (rows.length !== 1) return;
              const state = yield* Schema.decodeUnknownEffect(Accounts)(rows[0]).pipe(
                Effect.mapError(() => new StorageError()),
              );
              yield* sql`select id from executor_apps where id = ${app.id} and owner = ${owner} for update`.pipe(
                Effect.mapError(() => new StorageError()),
              );
              const locked = yield* executor.apps.get({ owner, app: app.id });
              if (locked.activeDeployment !== current.activeDeployment) return;
              const saved = yield* savedAccount(state.accounts);
              // A recorded account that was deliberately deleted is not a new-user setup.
              // Keep that intent: inventory reads must not recreate credentials or choose a replacement.
              if (Object.hasOwn(state.accounts, user.userId) && saved === undefined) return;
              if (
                saved !== undefined &&
                (saved.provider !== requirement.provider || saved.method !== "apiKey")
              )
                return yield* new StorageError();
              const eligible =
                yield* sql`select member.id from member join "user" on "user".id = member."userId"
                where member."organizationId" = ${organization} and member."userId" = ${user.userId}
                and member.role in ('owner', 'admin') and (${requireVerifiedEmail} = false or "user"."emailVerified" = true)
                for share of member, "user"`.pipe(Effect.mapError(() => new StorageError()));
              if (eligible.length === 0) return;
              const token =
                saved === undefined
                  ? yield* managedAccountKey(organization, user.userId).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    )
                  : undefined;
              const account =
                saved !== undefined
                  ? saved
                  : token !== undefined
                    ? yield* executor.accounts
                        .add({
                          owner,
                          provider: requirement.provider,
                          method: "apiKey",
                          label: user.name,
                          fields: Redacted.make({ token: Redacted.value(token), organization }),
                        })
                        .pipe(personalAccountCreation(user.userId))
                    : yield* new StorageError();
              // One durable personal profile follows the common Executor deployment.
              yield* executor.apps.profiles.create({
                app: app.id,
                owner,
                subject: user.userId,
                idempotencyKey: "executor-default",
                accounts: { service: account.id },
              });
              const accounts = JSON.stringify({ ...state.accounts, [user.userId]: account.id });
              yield* sql`update "organization" set metadata = jsonb_set(jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorKeyAccounts}', ${accounts}::jsonb),
            '{executorDefaults}', jsonb_build_object('installed', true, 'app', ${app.id}::text, 'deployment', ${current.activeDeployment}::text)
          )::text where id = ${organization}`.pipe(Effect.mapError(() => new StorageError()));
              return saved === undefined;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () => Effect.fail(new StorageError())),
            Effect.uninterruptible,
          );
      }).pipe(Effect.scoped),
    );
  });
