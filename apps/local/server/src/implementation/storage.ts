import { makeExecutorStorage } from "@executor-js/sdk/core";
import { createDataStepJournal } from "@executor-js/app-management/data-steps";
import { startupPhase } from "./startup-diagnostics.ts";
import { localDatabase } from "./local-database.ts";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import * as Migrator from "effect/sql/Migrator";

const appAccountLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table local_app_account_links (
    app text not null references executor_apps(id) on delete cascade,
    requirement text not null,
    subject text,
    account text not null references executor_accounts(id) on delete cascade,
    created_at timestamp with time zone not null default now()
  )`;
  yield* sql`create unique index local_app_account_links_app
    on local_app_account_links (app, requirement, account) where subject is null`;
  yield* sql`create unique index local_app_account_links_user
    on local_app_account_links (app, subject, requirement, account) where subject is not null`;
  yield* sql`create index local_app_account_links_account on local_app_account_links (account)`;
  yield* sql`insert into local_app_account_links (app, requirement, subject, account, created_at)
    select selected.app, selected.requirement, 'local', selected.account, min(selected.created_at)
      from (
        select i.app, i.created_at, b.key as requirement, a.id as account,
            row_number() over (partition by i.id, b.key order by e.ord) as position,
            case when d.requirements is null then jsonb_typeof(b.value) = 'string'
              else d.requirements::jsonb -> 'accounts' -> b.key ->> 'cardinality' = 'one' end
              as plain
          from executor_installations i
          join executor_apps app on app.id = i.app
          left join executor_deployments d on d.id = app.active_deployment
          cross join lateral jsonb_each(i.accounts::jsonb) b
          cross join lateral jsonb_array_elements_text(case jsonb_typeof(b.value)
              when 'array' then b.value
              when 'string' then jsonb_build_array(b.value)
              else '[]'::jsonb end) with ordinality e(account, ord)
          join executor_accounts a on a.id = e.account and a.owner = app.owner
          where i.enabled and i.status not in ('removing', 'removed')
            and not exists (select 1 from executor_profile_app_copies c,
              jsonb_array_elements_text(c.profiles::jsonb) listed(id) where listed.id = i.id)
      ) selected
      where selected.plain is not true or selected.position = 1
      group by selected.app, selected.requirement, selected.account
    on conflict do nothing`;
});

const migrateLocalProduct = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_local_migrations (
    migration_id integer primary key,
    created_at timestamp with time zone not null default now(),
    name text not null
  )`;
  yield* Migrator.make({})({
    table: "private_local_migrations",
    loader: Migrator.fromRecord({
      "1_data_steps": createDataStepJournal("private_local"),
      "2_app_account_links": appAccountLinks,
    }),
  });
});

export const openStorage = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const location = path.join(directory, "executor.pglite");
    yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
    yield* fs.chmod(location, 0o700);
    const context = yield* Layer.build(localDatabase(location));
    const sql = Context.get(context, SqlClient.SqlClient);
    const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    yield* storage.migrate;
    yield* migrateLocalProduct.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { storage, sql };
  }).pipe(startupPhase("storage"));
