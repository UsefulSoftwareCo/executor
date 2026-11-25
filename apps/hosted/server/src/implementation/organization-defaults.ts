import { organizationAppCreation, personalAccountCreation } from "./resource-lifecycle.ts";
import type { HostedApiDocument } from "../contracts/api.ts";
import { managedAccountKey } from "./api-keys.ts";
import { managedKeyEligible } from "./managed-key-eligibility.ts";
import { sourceFilesEqual } from "@executor-js/sdk/core";
import { AccountId, AppId, StorageError, StorageHost, type Executor } from "@executor-js/sdk/core";
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

const executorApp = Effect.promise(() => import("./executor-app.ts"));

const State = Schema.Struct({
  initialized: Schema.Boolean,
  app: Schema.NullOr(AppId),
  accounts: Schema.Record(Schema.String, AccountId),
});
const Accounts = Schema.Struct({ accounts: Schema.Record(Schema.String, AccountId) });

export const organizationDefaults = (
  executor: Executor,
  resourceOrigin: string,
  document: Effect.Effect<HostedApiDocument>,
  requireVerifiedEmail = true,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationDefaults.of((organization, user) => {
      let intent = false;
      return Effect.gen(function* () {
        const rows = yield* sql`select
          coalesce((metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false) as initialized,
          metadata::jsonb -> 'executorDefaults' ->> 'app' as app,
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
          yield* sql`update "organization" set metadata = jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorDefaults}',
            jsonb_build_object('installed', true, 'app', ${installed.id}::text, 'deployment', ${approved}::text)
          )::text where id = ${organization}
            and not coalesce((metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false)`.pipe(
            Effect.mapError(() => new StorageError()),
          );
        }
        if (user === undefined) return;
        if (Object.hasOwn(state.accounts, user.userId)) return;
        const app =
          state.app === null
            ? (yield* executor.apps.list({ owner, name: "Executor" }))[0]
            : yield* executor.apps
                .get({ owner, app: state.app })
                .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
        if (app === undefined) return;
        yield* executor[StorageHost]
          .transaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`select coalesce(metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb) as accounts
            from "organization" where id = ${organization} for no key update`.pipe(
                  Effect.mapError(() => new StorageError()),
                );
              if (rows.length !== 1) return;
              const state = yield* Schema.decodeUnknownEffect(Accounts)(rows[0]).pipe(
                Effect.mapError(() => new StorageError()),
              );
              if (Object.hasOwn(state.accounts, user.userId)) return;
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${`executor-defaults:${app.id}`}, 0))`.pipe(
                Effect.mapError(() => new StorageError()),
              );
              const requirement = (yield* executor.apps.get({ owner, app: app.id })).requirements
                .accounts.service;
              if (requirement === undefined) return;
              if (
                !(yield* managedKeyEligible(sql, organization, user.userId, requireVerifiedEmail))
              )
                return;
              const token = yield* managedAccountKey(organization, user.userId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
              const account = yield* executor.managedAccounts
                .add({
                  owner,
                  provider: requirement.provider,
                  method: "apiKey",
                  label: "Your Executor access",
                  fields: Redacted.make({ token: Redacted.value(token), organization }),
                })
                .pipe(personalAccountCreation(user.userId));
              if (
                yield* addLink(sql, executor.webhooks, {
                  app: app.id,
                  requirement: "service",
                  account: account.id,
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
              const accounts = JSON.stringify({ ...state.accounts, [user.userId]: account.id });
              yield* sql`update "organization" set metadata = jsonb_set(
            coalesce(metadata::jsonb, '{}'::jsonb), '{executorKeyAccounts}', ${accounts}::jsonb
          )::text where id = ${organization}`.pipe(Effect.mapError(() => new StorageError()));
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
