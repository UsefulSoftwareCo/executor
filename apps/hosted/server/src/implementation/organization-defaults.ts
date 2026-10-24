import { organizationAppCreation, personalAccountCreation } from "./resource-lifecycle.ts";
import type { HostedApiDocument } from "../contracts/api.ts";
import { managedAccountKey } from "./api-keys.ts";
import { pinnedOnly } from "@executor-js/app-management/data-steps";
import { sourceFilesEqual } from "@executor-js/sdk/core";
import {
  AccountId,
  AppId,
  VersionId,
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
import { addLink } from "./app-accounts.ts";
import { executorCopyOrigin } from "./executor-catalog-entry.ts";
import { productBrandConfig } from "@executor-js/utils/product-brand";

/** Only a new or changed installation generates the Executor app, so its OpenAPI compiler loads then. */
const executorApp = Effect.promise(() => import("./executor-app.ts"));

const State = Schema.Struct({
  initialized: Schema.Boolean,
  app: Schema.NullOr(AppId),
  version: Schema.NullOr(VersionId),
  accounts: Schema.Record(Schema.String, AccountId),
});
const Accounts = Schema.Struct({ accounts: Schema.Record(Schema.String, AccountId) });

/**
 * Install once, then create missing user accounts or repair their links. Completed setup is
 * read-only. The Executor app calls this installation's API at its resource origin.
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
      // Upgrading the installed app makes its webhook sources pending, and member setup links an
      // account. Either is saved intent, which must wake source reconciliation once it commits.
      let intent = false;
      return Effect.gen(function* () {
        const rows = yield* sql`select
          coalesce((metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false) as initialized,
          metadata::jsonb -> 'executorDefaults' ->> 'app' as app,
          metadata::jsonb -> 'executorDefaults' ->> 'deployment' as version,
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
            yield* executor.apps
              .copy({
                from: {
                  files: source.files,
                  origin: executorCopyOrigin(resourceOrigin),
                  activation: "deploy",
                },
                owner,
                name: "Executor",
              })
              .pipe(
                organizationAppCreation,
                Effect.catchTags({
                  AppNameTaken: () => Effect.void,
                  AppSlugTaken: () => Effect.void,
                  // A snapshot reads no registry or earlier app.
                  RegistryError: Effect.die,
                  VersionNotFound: Effect.die,
                  AppNotDeployed: Effect.die,
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
        // The recorded version is the one Executor installed or verified. While it is still
        // active nobody has deployed over it, so the current template may replace it.
        if (state.version !== null && state.version === app.activeVersion) {
          const version = yield* executor.apps.source({ owner, app: app.id });
          if (version.id !== app.activeVersion) return;
          const { defaultExecutorAppSource } = yield* executorApp;
          const source = yield* defaultExecutorAppSource(resourceOrigin, yield* document);
          if (!sourceFilesEqual(version.files, source.files)) {
            // A failed upgrade keeps the working installation, and member setup continues.
            const upgraded = yield* Effect.gen(function* () {
              const workspace = yield* executor.apps.workspace({ owner, app: app.id });
              // Unsaved edits mean someone is changing this copy; leave it to them. The framework
              // pin is a system commit, not an edit.
              if (!pinnedOnly(workspace.files, version.files)) return undefined;
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
                to_jsonb(${upgraded.activeVersion}::text)
              )::text where id = ${organization}`.pipe(Effect.mapError(() => new StorageError()));
            }
          }
        } else if (state.version !== app.activeVersion) {
          const version = yield* executor.apps.source({ owner, app: app.id });
          if (version.id !== app.activeVersion) return;
          const { defaultExecutorAppSource, executorAppSource } = yield* executorApp;
          const source = yield* defaultExecutorAppSource(resourceOrigin, yield* document);
          if (!sourceFilesEqual(version.files, source.files)) {
            // Upgrade only the untouched, unconfigured catalog version. Preserve user edits and connections.
            const catalog = yield* executorAppSource(resourceOrigin, yield* document);
            if (!sourceFilesEqual(version.files, catalog.files)) return;
            const workspace = yield* executor.apps.workspace({ owner, app: app.id });
            if (!pinnedOnly(workspace.files, version.files)) return;
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
        const saved = yield* savedAccount(state.accounts);
        // A recorded account that was deliberately deleted is not a new-user setup.
        // Keep that intent: inventory reads must not recreate credentials or choose a replacement.
        if (Object.hasOwn(state.accounts, user.userId) && saved === undefined) return;
        if (
          saved !== undefined &&
          (saved.provider !== requirement.provider || saved.method !== "apiKey")
        )
          return yield* new StorageError();
        // Existing saved accounts keep their credential and links; setup does not mint replacement
        // keys or link them again, so a member's unlink stays. Read current SQL metadata on every
        // call; this is not an isolate-local result cache.
        if (state.version === current.activeVersion && saved !== undefined) return;
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
              // below runs inside this transaction and observes a committed version.
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${`executor-defaults:${app.id}`}, 0))`.pipe(
                Effect.mapError(() => new StorageError()),
              );
              const locked = yield* executor.apps.get({ owner, app: app.id });
              if (locked.activeVersion !== current.activeVersion) return;
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
              const account =
                saved ??
                (yield* Effect.gen(function* () {
                  const token = yield* managedAccountKey(organization, user.userId).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  );
                  const created = yield* executor.managedAccounts
                    .add({
                      owner,
                      provider: requirement.provider,
                      method: "apiKey",
                      // Email sign-ups have no name; say whose access this is instead.
                      label: `Your ${(yield* productBrandConfig.pipe(Effect.orDie)).name} access`,
                      fields: Redacted.make({ token: Redacted.value(token), organization }),
                    })
                    .pipe(personalAccountCreation(user.userId));
                  // A new managed key is linked to the common Executor app once, when it is
                  // created. A member who unlinks it later keeps that choice.
                  if (
                    yield* addLink(sql, executor.webhooks, {
                      app: app.id,
                      requirement: "service",
                      account: created.id,
                      subject: user.userId,
                      linkedBy: user.userId,
                    }).pipe(
                      Effect.catchTags({
                        RequirementMismatch: () => new StorageError(),
                        AccountNotFound: () => new StorageError(),
                      }),
                    )
                  )
                    intent = true;
                  return created;
                }));
              const accounts = JSON.stringify({ ...state.accounts, [user.userId]: account.id });
              yield* sql`update "organization" set metadata = jsonb_set(jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorKeyAccounts}', ${accounts}::jsonb),
            '{executorDefaults}', jsonb_build_object('installed', true, 'app', ${app.id}::text, 'deployment', ${current.activeVersion}::text)
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
