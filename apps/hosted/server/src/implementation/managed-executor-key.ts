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

/**
 * The Executor app's managed account presented a key the server no longer holds, almost always
 * because its owner revoked "Executor app (created automatically)" on the Tokens page. Mint a new
 * managed key for the same member and organization and save it in the same account, so the app
 * works again without anyone reconnecting it.
 *
 * It answers true only for a refusal from a run of the organization's Executor app itself: the app
 * the SDK was running (`input.app`, never a value app code supplies) must be the one install
 * recorded (`executorDefaults.app`). Any other app, even one the account is linked to, gets false
 * before anything is read under a lock, which leaves its call exactly as without this hook. Then,
 * under the organization row's lock and the account row's lock, all of these must hold:
 *
 * - the account is the one member setup recorded for this member (`executorKeyAccounts`), and is
 *   still this member's link of the Executor app;
 * - the member may hold a managed key today (owner or admin, verified where required);
 * - the refused key has no row at all, so a disabled key stays refused. The bearer check deletes
 *   an expired key on its first refused use, after which it is renewed as a revoked one; the
 *   product mints these keys with no expiry, and nothing in the product sets one;
 * - the account holds the credential generation the product wrote (`executorKeyGenerations`,
 *   absent meaning the one setup created, 0), so a member's own token is never replaced.
 *
 * When the refused generation is still current, a key is minted; when another renewal moved the
 * account to the product's next generation, that one is used. Anything else is false. The new key
 * is pinned to the organization, is marked as the Executor app's in its own metadata, and carries
 * the member's own role, exactly what they could mint on the Tokens page.
 */
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
      /** What install and member setup recorded: the Executor app, this member's account and generation. */
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
      // Another app learns nothing here: it is answered before any lock or other read.
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
            // The organization row serializes renewals with member setup, as setup does: only
            // metadata changes, so the non-key lock, which a role change's trigger does not wait on.
            const state = yield* recorded(true);
            if (
              state === undefined ||
              state.app !== input.app.id ||
              state.account !== input.account.id
            )
              return false;
            // Every credential writer locks the account row before reading its generation.
            const accounts =
              yield* sql`select credential_generation as generation from executor_accounts
              where id = ${input.account.id} and owner = ${input.account.owner} for update`;
            const current = Option.getOrUndefined(
              Schema.decodeUnknownOption(Generation)(accounts[0] ?? null),
            );
            if (current === undefined) return false;
            // Still this member's link of the Executor app: an unlinked account is never renewed.
            const linked = yield* sql`select 1 from hosted_app_account_links
              where app = ${input.app.id} and account = ${input.account.id} and subject = ${user}`;
            if (linked.length === 0) return false;
            if (!(yield* managedKeyEligible(sql, organization, user, verified))) return false;
            // Only a key with no row is renewed: a disabled one stays refused. An expired key was
            // deleted by its first refused use, so it is renewed as a revoked one.
            const known = yield* sql`select id from apikey where key = ${hash}`;
            if (known.length !== 0) return false;
            const product = state.generation ?? 0;
            // Another call renewed it since this refusal: use that key, the product's own.
            if (current.generation !== input.generation) return current.generation === product;
            // The member saved credentials of their own in it; those are theirs to replace.
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
            // A sibling of `executorKeyAccounts`, whose values stay plain account IDs for servers
            // that predate it; absent means the generation setup created, 0. Under the account
            // row's lock, the replacement above wrote exactly this generation.
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
