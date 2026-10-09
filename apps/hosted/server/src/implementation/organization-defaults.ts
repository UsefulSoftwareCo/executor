import { organizationAppCreation, personalAccountCreation } from "./resource-lifecycle.ts";
import type { HostedApiDocument } from "../contracts/api.ts";
import { managedAccountKey } from "./api-keys.ts";
import { pinnedOnly } from "@executor-js/app-management/data-steps";
import { sourceFilesEqual } from "@executor-js/sdk/core";
import {
  AccountId,
  AppId,
  DeploymentId,
  StorageError,
  StorageHost,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  OrganizationDefaults,
  OrganizationDefaultsPending,
} from "../contracts/organization-defaults.ts";
import { organizationOwner } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";

/** Only a new or changed installation generates the Executor app, so its OpenAPI compiler loads then. */
const executorApp = Effect.promise(() => import("./executor-app.ts"));

const State = Schema.Struct({
  initialized: Schema.Boolean,
  app: Schema.NullOr(AppId),
  deployment: Schema.NullOr(DeploymentId),
  accounts: Schema.Record(Schema.String, AccountId),
});
const Accounts = Schema.Struct({ accounts: Schema.Record(Schema.String, AccountId) });

/**
 * Install once, then create missing user accounts or repair automatic selections. Completed setup
 * is read-only. The Executor app calls this installation's API at its resource origin.
 */
export const organizationDefaults = (
  executor: Executor,
  resourceOrigin: string,
  document: Effect.Effect<HostedApiDocument>,
  requireVerifiedEmail = true,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationDefaults.of((organization, user) => {
      // Upgrading the installed app makes its profiles pending, and member setup saves a
      // profile. Either is saved setup intent, which must wake profile setup once it commits.
      let intent = false;
      return Effect.gen(function* () {
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
          const source = yield* defaultExecutorAppSource(resourceOrigin, yield* document);
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
          // Concurrent installers all reach this write; the unique app name gave them one app.
          // The first record wins, so a later one cannot replace what member setup recorded since.
          yield* sql`update "organization" set metadata = jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorDefaults}',
            jsonb_build_object('installed', true, 'app', ${installed.id}::text, 'deployment', ${approved}::text)
          )::text where id = ${organization}
            and not coalesce((metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false)`.pipe(
            Effect.mapError(() => new StorageError()),
          );
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
        // The recorded deployment is the one Executor installed or verified. While it is still
        // active nobody has deployed over it, so the current template may replace it.
        if (state.deployment !== null && state.deployment === app.activeDeployment) {
          const deployment = yield* executor.apps.source({ owner, app: app.id });
          if (deployment.id !== app.activeDeployment) return;
          const { defaultExecutorAppSource } = yield* executorApp;
          const source = yield* defaultExecutorAppSource(resourceOrigin, yield* document);
          if (!sourceFilesEqual(deployment.files, source.files)) {
            // A failed upgrade keeps the working installation, and member setup continues.
            const upgraded = yield* Effect.gen(function* () {
              const workspace = yield* executor.apps.workspace({ owner, app: app.id });
              // Unsaved edits mean someone is changing this copy; leave it to them. The framework
              // pin is a system commit, not an edit.
              if (!pinnedOnly(workspace.files, deployment.files)) return undefined;
              const deployed = yield* executor.apps.deploy({
                owner,
                app: app.id,
                files: source.files,
              });
              intent = true;
              return deployed.app;
            }).pipe(
              Effect.catch(() =>
                Effect.logWarning("Executor app upgrade failed").pipe(Effect.as(undefined)),
              ),
            );
            if (upgraded !== undefined) {
              current = upgraded;
              yield* sql`update "organization" set metadata = jsonb_set(
                coalesce(metadata::jsonb, '{}'::jsonb), '{executorDefaults,deployment}',
                to_jsonb(${upgraded.activeDeployment}::text)
              )::text where id = ${organization}`.pipe(Effect.mapError(() => new StorageError()));
            }
          }
        } else if (state.deployment !== app.activeDeployment) {
          const deployment = yield* executor.apps.source({ owner, app: app.id });
          if (deployment.id !== app.activeDeployment) return;
          const { defaultExecutorAppSource, executorAppSource } = yield* executorApp;
          const source = yield* defaultExecutorAppSource(resourceOrigin, yield* document);
          if (!sourceFilesEqual(deployment.files, source.files)) {
            // Upgrade only the untouched, unconfigured catalog version. Preserve user edits and connections.
            const catalog = yield* executorAppSource(resourceOrigin, yield* document);
            if (!sourceFilesEqual(deployment.files, catalog.files)) return;
            const workspace = yield* executor.apps.workspace({ owner, app: app.id });
            if (!pinnedOnly(workspace.files, deployment.files)) return;
            current = (yield* executor.apps.deploy({
              owner,
              app: app.id,
              files: source.files,
            })).app;
            intent = true;
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
        const existingProfile =
          (yield* executor.apps.profiles.list({
            app: app.id,
            owner,
            subject: user.userId,
            idempotencyKey: "executor-default",
          }))[0] ?? null;
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
        yield* executor[StorageHost]
          .transaction(
            Effect.gen(function* () {
              // Only metadata changes, so take the non-key lock. It still serializes member
              // setup, but not a role change whose trigger checks the organization key; with
              // `for update` that check and this setup's member lock deadlocked.
              const rows =
                yield* sql`select coalesce(metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb) as accounts
            from "organization" where id = ${organization} for no key update`.pipe(
                  Effect.mapError(() => new StorageError()),
                );
              if (rows.length !== 1) return;
              const state = yield* Schema.decodeUnknownEffect(Accounts)(rows[0]).pipe(
                Effect.mapError(() => new StorageError()),
              );
              // Serialize member setup per app without touching the SDK's rows; the SDK read
              // below runs inside this transaction and observes a committed deployment.
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${`executor-defaults:${app.id}`}, 0))`.pipe(
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
                          // Email sign-ups have no name; say whose access this is instead.
                          label: "Your Executor access",
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
              intent = true;
              const accounts = JSON.stringify({ ...state.accounts, [user.userId]: account.id });
              yield* sql`update "organization" set metadata = jsonb_set(jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorKeyAccounts}', ${accounts}::jsonb),
            '{executorDefaults}', jsonb_build_object('installed', true, 'app', ${app.id}::text, 'deployment', ${current.activeDeployment}::text)
          )::text where id = ${organization}`.pipe(Effect.mapError(() => new StorageError()));
              return saved === undefined;
            }),
          )
          .pipe(Effect.uninterruptible);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.suspend(() => (intent ? Effect.flatten(ScheduleWakeup) : Effect.void)),
        ),
      );
    });
  });
