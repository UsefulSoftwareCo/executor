import { organizationAppCreation, personalAccountCreation } from "./resource-lifecycle.ts";
import type { HostedApiDocument } from "../contracts/api.ts";
import { managedAccountKey } from "./api-keys.ts";
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
import { provisionAccountLink } from "./app-accounts.ts";
import { executorCopyOrigin } from "./executor-catalog-entry.ts";

/** Only a new or changed installation generates the Executor app, so its OpenAPI compiler loads then. */
const executorApp = Effect.promise(() => import("./executor-app.ts"));

const State = Schema.Struct({
  initialized: Schema.Boolean,
  app: Schema.NullOr(AppId),
  accounts: Schema.Record(Schema.String, AccountId),
});
const Accounts = Schema.Struct({ accounts: Schema.Record(Schema.String, AccountId) });

/**
 * Install once, then give each new member a managed key linked to the installed app. The app is
 * never redeployed here; it changes only as the organization edits it, like any other app. The
 * Executor app calls this installation's API at its resource origin.
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
      // Member setup linking an account is saved intent, which must wake source reconciliation
      // once it commits.
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
        // A recorded member already has a key, or deliberately deleted it. Setup never replaces
        // either, and never changes the app: it is the organization's to edit and deploy.
        if (Object.hasOwn(state.accounts, user.userId)) return;
        // The stored ID follows renames; deletion never recreates an initialized app.
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
              if (Object.hasOwn(state.accounts, user.userId)) return;
              // Serialize member setup per app without touching the SDK's rows; the SDK read
              // below runs inside this transaction and observes a committed version.
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${`executor-defaults:${app.id}`}, 0))`.pipe(
                Effect.mapError(() => new StorageError()),
              );
              // The key fits whatever version is active now; an app without the slot gets none.
              const requirement = (yield* executor.apps.get({ owner, app: app.id })).requirements
                .accounts.service;
              if (requirement === undefined) return;
              const eligible =
                yield* sql`select member.id from member join "user" on "user".id = member."userId"
                where member."organizationId" = ${organization} and member."userId" = ${user.userId}
                and member.role in ('owner', 'admin') and (${requireVerifiedEmail} = false or "user"."emailVerified" = true)
                for share of member, "user"`.pipe(Effect.mapError(() => new StorageError()));
              if (eligible.length === 0) return;
              const token = yield* managedAccountKey(organization, user.userId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
              const account = yield* executor.managedAccounts
                .add({
                  owner,
                  provider: requirement.provider,
                  method: "apiKey",
                  // Email sign-ups have no name; say whose access this is instead.
                  label: "Your Executor access",
                  fields: Redacted.make({ token: Redacted.value(token), organization }),
                })
                .pipe(personalAccountCreation(user.userId));
              // A new managed key is linked to the common Executor app once, when it is
              // created. A member who unlinks it later keeps that choice.
              if (
                yield* provisionAccountLink(sql, executor.webhooks, {
                  app: app.id,
                  requirement: "service",
                  account: account.id,
                  subject: user.userId,
                  linkedBy: user.userId,
                })
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
