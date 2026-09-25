/** A control registry survives failed builds, stopped terminals, and failed cloud deletion. */
import { Client } from "pg";
import { Config, Deferred, Effect, Redacted, Schema } from "effect";
import {
  TestStageFailed,
  TestStageLease,
  testStageLifetimeMilliseconds,
} from "../contracts/test-stage-lifetime.ts";

const failed = (message: string) => new TestStageFailed({ message });
const registry = (client: Client) => {
  const query = <S extends Schema.Constraint>(
    schema: S,
    statement: string,
    values: readonly unknown[] = [],
  ) =>
    Effect.tryPromise({
      try: () => client.query(statement, [...values]),
      catch: () => failed("The preview control database query failed."),
    }).pipe(
      Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Array(schema))(result.rows)),
      Effect.mapError(() =>
        failed("The preview control database query failed or returned an invalid result."),
      ),
    );
  const projection = `slug, owner, database_provider as database, retention, background,
    (extract(epoch from created_at) * 1000)::float8 as "createdAt",
    (extract(epoch from expires_at) * 1000)::float8 as "expiresAt"`;
  const list = query(
    TestStageLease,
    `select ${projection} from executor_test_stage_leases order by created_at, slug`,
  );
  const get = (slug: string) =>
    query(TestStageLease, `select ${projection} from executor_test_stage_leases where slug = $1`, [
      slug,
    ]).pipe(Effect.map((rows) => rows[0]));
  const reserve = (input: {
    readonly slug: string;
    readonly owner: string;
    readonly database: "neon" | "planetscale";
    readonly retention: "temporary" | "retained";
    readonly background: "active" | "paused";
  }) =>
    Effect.gen(function* () {
      // Only the first insert sets the deadline. Retrying cannot renew it.
      yield* query(
        Schema.Unknown,
        `with started as (select clock_timestamp() as at)
         insert into executor_test_stage_leases (slug, owner, created_at, expires_at, database_provider, retention, background)
         select $1, $2, at, case when $5 = 'temporary' then at + $3 * interval '1 millisecond' else null end, $4, $5, $6 from started
         on conflict (slug) do nothing`,
        [
          input.slug,
          input.owner,
          testStageLifetimeMilliseconds,
          input.database,
          input.retention,
          input.background,
        ],
      );
      const lease = yield* get(input.slug);
      if (lease === undefined) return yield* failed("Could not reserve the preview lease.");
      if (lease.database !== input.database || lease.retention !== input.retention)
        return yield* failed(
          "A preview's database and retention cannot change on redeploy. Use a new slug.",
        );
      yield* query(
        Schema.Unknown,
        "update executor_test_stage_leases set background = $2 where slug = $1",
        [input.slug, input.background],
      );
      const updated = yield* get(input.slug);
      if (updated === undefined) return yield* failed("Could not update the preview lease.");
      return updated;
    });
  const remove = (slug: string) =>
    query(Schema.Unknown, "delete from executor_test_stage_leases where slug = $1", [slug]);
  const observe = (stage: { readonly slug: string; readonly createdAt: number }) =>
    query(
      Schema.Unknown,
      `insert into executor_test_stage_leases (slug, owner, created_at, expires_at, database_provider, retention, background)
     values ($1, 'Discovered preview', to_timestamp($2::float8 / 1000), to_timestamp($2::float8 / 1000) + interval '3 hours', 'planetscale', 'temporary', 'active')
     on conflict (slug) do nothing`,
      [stage.slug, stage.createdAt],
    );
  const lock = (slug: string) =>
    query(
      Schema.Struct({ locked: Schema.Boolean }),
      "select pg_try_advisory_lock(1163412818, hashtext($1)) as locked",
      [slug],
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0]?.locked === true
          ? Effect.void
          : Effect.fail(failed(`Another operation is running for preview ${slug}.`)),
      ),
    );
  return { list, get, reserve, remove, lock, observe };
};

/** Connect only to the shared staging control database, which holds leases and per-stage locks. */
export const withStageAdmin = <A, E, R>(
  use: (admin: ReturnType<typeof registry>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const configured = yield* Config.Redacted("TEST_STAGE_DATABASE_ADMIN_URL");
      const origin = yield* Effect.try({
        try: () => new URL(Redacted.value(configured)),
        catch: () => failed("Invalid staging control database URL."),
      });
      if (
        (origin.port !== "5432" && !["localhost", "127.0.0.1"].includes(origin.hostname)) ||
        origin.pathname !== "/postgres" ||
        !origin.username.includes(".")
      )
        return yield* failed(
          "The staging control database needs a direct PlanetScale URL for postgres.",
        );
      const disconnected = yield* Deferred.make<never, TestStageFailed>();
      const lost = () => {
        // Native socket events can arrive while scope finalizers are closing the client.
        Deferred.doneUnsafe(
          disconnected,
          Effect.fail(
            failed("The staging control connection closed. The operation was interrupted."),
          ),
        );
      };
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const client = new Client({
            connectionString: Redacted.value(configured),
            connectionTimeoutMillis: 15000,
            query_timeout: 15000,
            application_name: "executor-test-stage",
          });
          client.on("error", lost);
          client.on("end", lost);
          return client;
        }),
        (client) =>
          Effect.promise(() => client.end()).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                client.off("error", lost);
                client.off("end", lost);
              }),
            ),
          ),
      );
      return yield* Effect.raceFirst(
        Deferred.await(disconnected),
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => client.connect(),
            catch: () => failed("Cannot connect to the staging control database."),
          });
          yield* Effect.tryPromise({
            try: () =>
              client.query(`begin;
        select pg_advisory_xact_lock(1163412818, 0);
        create table if not exists executor_test_stage_leases (
          slug text primary key check (slug ~ '^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$'),
          owner text not null check (length(owner) > 0),
          created_at timestamptz not null,
          expires_at timestamptz
        );
        alter table executor_test_stage_leases
          add column if not exists database_provider text not null default 'planetscale',
          add column if not exists retention text not null default 'temporary',
          add column if not exists background text not null default 'active',
          alter column expires_at drop not null,
          drop constraint if exists executor_test_stage_leases_check;
        do $$ begin
          if not exists (select 1 from pg_constraint where conrelid = 'executor_test_stage_leases'::regclass and conname = 'preview_policy') then
            alter table executor_test_stage_leases add constraint preview_policy check (
              database_provider in ('neon', 'planetscale') and (
                (retention = 'temporary' and background = 'active' and expires_at is not null and expires_at = created_at + interval '3 hours') or
                (retention = 'retained' and background in ('active', 'paused') and expires_at is null)
              )
            );
          end if;
        end $$;
        commit;`),
            catch: () => failed("Could not initialize the staging control registry."),
          });
          return yield* use(registry(client));
        }),
      );
    }),
  );
