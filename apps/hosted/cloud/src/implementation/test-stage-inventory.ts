/** A control registry survives failed builds, stopped terminals, and failed cloud deletion. */
import { Client } from "pg";
import { Config, Effect, Redacted, Schema } from "effect";
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
  const projection = `slug, owner,
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
  const reserve = (input: { readonly slug: string; readonly owner: string }) =>
    Effect.gen(function* () {
      // Only the first insert sets the deadline. Retrying cannot renew it.
      yield* query(
        Schema.Unknown,
        `with started as (select clock_timestamp() as at)
         insert into executor_test_stage_leases (slug, owner, created_at, expires_at)
         select $1, $2, at, at + $3 * interval '1 millisecond' from started
         on conflict (slug) do nothing`,
        [input.slug, input.owner, testStageLifetimeMilliseconds],
      );
      const lease = yield* get(input.slug);
      if (lease === undefined) return yield* failed("Could not reserve the preview lease.");
      return lease;
    });
  const remove = (slug: string) =>
    query(Schema.Unknown, "delete from executor_test_stage_leases where slug = $1", [slug]);
  const observe = (stage: { readonly slug: string; readonly createdAt: number }) =>
    query(
      Schema.Unknown,
      `insert into executor_test_stage_leases (slug, owner, created_at, expires_at)
     values ($1, 'Discovered preview', to_timestamp($2::float8 / 1000), to_timestamp($2::float8 / 1000) + interval '3 hours')
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
        origin.port !== "5432" ||
        origin.pathname !== "/postgres" ||
        !origin.username.includes(".")
      )
        return yield* failed(
          "The staging control database needs a direct PlanetScale URL for postgres.",
        );
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client({
              connectionString: Redacted.value(configured),
              connectionTimeoutMillis: 15000,
              query_timeout: 15000,
              application_name: "executor-test-stage",
            }),
        ),
        (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
      );
      const disconnected = Effect.callback<never, TestStageFailed>((resume) => {
        const lost = () =>
          resume(
            Effect.fail(
              failed("The staging control connection closed. The operation was interrupted."),
            ),
          );
        client.on("error", lost);
        client.on("end", lost);
        return Effect.sync(() => {
          client.off("error", lost);
          client.off("end", lost);
        });
      });
      return yield* Effect.raceFirst(
        disconnected,
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => client.connect(),
            catch: () => failed("Cannot connect to the staging control database."),
          });
          yield* Effect.tryPromise({
            try: () =>
              client.query(`create table if not exists executor_test_stage_leases (
          slug text primary key check (slug ~ '^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$'),
          owner text not null check (length(owner) > 0),
          created_at timestamptz not null,
          expires_at timestamptz not null,
          check (expires_at = created_at + interval '3 hours')
        )`),
            catch: () => failed("Could not initialize the staging control registry."),
          });
          return yield* use(registry(client));
        }),
      );
    }),
  );
