import { defaultKeyHasher } from "@better-auth/api-key";
import {
  AccountId,
  AppId,
  StorageError,
  StorageHost,
  type Executor,
  type ResourceLifecycle,
} from "@executor-js/sdk/core";
import { Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { OrganizationId } from "../contracts/organization.ts";
import { managedAccountKey } from "./api-keys.ts";
import { managedKeyEligible } from "./managed-key-eligibility.ts";

const Recorded = Schema.Struct({
  app: Schema.NullOr(AppId),
  account: Schema.NullOr(AccountId),
  generation: Schema.NullOr(Schema.NumberFromString),
});
const Generation = Schema.Struct({ generation: Schema.Number });
const ManagedFields = Schema.Struct({ token: Schema.String });

export const renewManagedExecutorKey =
  (executor: Effect.Effect<Executor, StorageError>, requireVerifiedEmail: Effect.Effect<boolean>) =>
  (
    input: Parameters<NonNullable<ResourceLifecycle["secretsRejected"]>>[0],
  ): Effect.Effect<boolean, StorageError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const user = yield* CurrentUserId;
      if (
        user === undefined ||
        input.app.owner !== input.account.owner ||
        !input.account.owner.startsWith("organization:")
      )
        return false;
      const organization = Option.getOrUndefined(
        Schema.decodeUnknownOption(OrganizationId)(
          input.account.owner.slice("organization:".length),
        ),
      );
      const rejected = Schema.decodeUnknownOption(ManagedFields)(Redacted.value(input.rejected));
      if (organization === undefined || Option.isNone(rejected)) return false;
      const token = rejected.value.token;
      if (!token.startsWith("exp_")) return false;
      const sql = yield* SqlClient.SqlClient;
      const recorded = (lock: boolean) =>
        Effect.map(
          lock
            ? sql`select metadata::jsonb -> 'executorDefaults' ->> 'app' as app,
                metadata::jsonb -> 'executorKeyAccounts' ->> ${user} as account,
                metadata::jsonb -> 'executorKeyGenerations' ->> ${user} as generation
                from "organization" where id = ${organization} for no key update`
            : sql`select metadata::jsonb -> 'executorDefaults' ->> 'app' as app,
                metadata::jsonb -> 'executorKeyAccounts' ->> ${user} as account,
                metadata::jsonb -> 'executorKeyGenerations' ->> ${user} as generation
                from "organization" where id = ${organization}`,
          (rows) => Option.getOrUndefined(Schema.decodeUnknownOption(Recorded)(rows[0] ?? null)),
        );
      const seen = yield* recorded(false);
      if (seen === undefined || seen.app !== input.app.id) return false;
      const instance = yield* executor;
      const verified = yield* requireVerifiedEmail;
      const hash = yield* Effect.tryPromise({
        try: () => defaultKeyHasher(token),
        catch: () => new StorageError(),
      });
      return yield* instance[StorageHost]
        .transaction(
          Effect.gen(function* () {
            const state = yield* recorded(true);
            if (
              state === undefined ||
              state.app !== input.app.id ||
              state.account !== input.account.id
            )
              return false;
            const accounts =
              yield* sql`select credential_generation as generation from executor_accounts
              where id = ${input.account.id} and owner = ${input.account.owner} for update`;
            const current = Option.getOrUndefined(
              Schema.decodeUnknownOption(Generation)(accounts[0] ?? null),
            );
            if (current === undefined) return false;
            const linked = yield* sql`select 1 from hosted_app_account_links
              where app = ${input.app.id} and account = ${input.account.id} and subject = ${user}`;
            if (linked.length === 0) return false;
            if (!(yield* managedKeyEligible(sql, organization, user, verified))) return false;
            const known = yield* sql`select id from apikey where key = ${hash}`;
            if (known.length !== 0) return false;
            const product = state.generation ?? 0;
            if (current.generation !== input.generation) return current.generation === product;
            if (product !== input.generation) return false;
            const key = yield* managedAccountKey(organization, user).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            yield* instance.managedAccounts
              .replaceCredentials({
                owner: input.account.owner,
                account: input.account.id,
                fields: Redacted.make({ token: Redacted.value(key), organization }),
              })
              .pipe(Effect.mapError(() => new StorageError()));
            yield* sql`update "organization" set metadata = jsonb_set(
              coalesce(metadata::jsonb, '{}'::jsonb), '{executorKeyGenerations}',
              coalesce(metadata::jsonb -> 'executorKeyGenerations', '{}'::jsonb)
                || jsonb_build_object(${user}::text, ${current.generation + 1}::int)
            )::text where id = ${organization}`;
            yield* Effect.annotateCurrentSpan("executor.managed_key.renewed", input.account.id);
            return true;
          }).pipe(Effect.catchTag("SqlError", () => Effect.fail(new StorageError()))),
        )
        .pipe(Effect.uninterruptible);
    }).pipe(
      Effect.catchTag("SqlError", () => Effect.fail(new StorageError())),
      Effect.withSpan("hosted.managedExecutorKey.renew"),
    );
