import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

const ProfileAccount = Schema.Struct({
  profile: Schema.String,
  account: Schema.String,
  copy: Schema.NullOr(Schema.String),
});
export type ProfileAccount = typeof ProfileAccount.Type;

export const profileAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`select i.id as profile, e #>> '{}' as account, (
        select c.id from executor_profile_app_copies c
          where c.status in ('pending', 'copied') and exists (
            select 1 from jsonb_array_elements_text(c.profiles::jsonb) listed(id)
              where listed.id = i.id)
          limit 1) as copy
    from executor_installations i
    cross join lateral jsonb_each(i.accounts::jsonb) b
    cross join lateral jsonb_array_elements(case jsonb_typeof(b.value)
        when 'array' then b.value
        when 'string' then jsonb_build_array(b.value)
        else '[]'::jsonb end) e
    join executor_accounts a on a.id = e #>> '{}'
    where i.enabled and i.status not in ('removing', 'removed') and jsonb_typeof(e) = 'string'`;
  return yield* Schema.decodeUnknownEffect(Schema.Array(ProfileAccount))(rows);
});

const step = "profile-targets";

const convertedTargets = (targets: string) => `(
  select coalesce(jsonb_agg(distinct target), '[]'::jsonb) from (
    select t.value as target from jsonb_array_elements(${targets}) t(value)
      where t.value ->> 'kind' <> 'profile'
    union
    select jsonb_build_object('kind', 'account', 'id', p.account)
      from jsonb_array_elements(${targets}) t(value)
      join jsonb_to_recordset($1::jsonb) p(profile text, account text, copy text)
        on p.profile = t.value ->> 'id' and p.copy is null
      where t.value ->> 'kind' = 'profile'
  ) converted)`;

const convertedApps = (policy: string, field: "runsAs" | "targets", prune: boolean) => `(
  select coalesce(jsonb_agg(converted.entry order by converted.position, converted.copy nulls first), '[]'::jsonb) from (
    select entry.position, null::text as copy, case when entry.value ? '${field}'
        then jsonb_set(entry.value, '{${field}}', ${convertedTargets(`entry.value -> '${field}'`)})
        else entry.value end as entry
      from jsonb_array_elements(${policy} -> 'apps') with ordinality entry(value, position)
    union all
    select entry.position, p.copy, jsonb_set(jsonb_set(entry.value, '{app}', to_jsonb(p.copy)),
        '{${field}}', jsonb_agg(distinct jsonb_build_object('kind', 'account', 'id', p.account)))
      from jsonb_array_elements(${policy} -> 'apps') with ordinality entry(value, position)
      cross join jsonb_array_elements(entry.value -> '${field}') t(value)
      join jsonb_to_recordset($1::jsonb) p(profile text, account text, copy text)
        on p.profile = t.value ->> 'id' and p.copy is not null
      where t.value ->> 'kind' = 'profile'
      group by entry.position, entry.value, p.copy
  ) converted${prune ? ` where jsonb_array_length(converted.entry -> '${field}') > 0` : ""})`;

export const convertProfileTargets = <E>(
  accounts: Effect.Effect<ReadonlyArray<ProfileAccount>, E>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`create table if not exists executor_local_steps (
      name text primary key,
      created_at timestamp with time zone not null default now()
    )`;
    const done = yield* sql`select 1 from executor_local_steps where name = ${step}`;
    if (done.length > 0) return;
    const mapping = JSON.stringify(yield* accounts);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `update "mcpConnection" c set policy = jsonb_set(c.policy::jsonb, '{apps}',
              ${convertedApps("c.policy::jsonb", "runsAs", true)})::text
            where exists (select 1 from jsonb_array_elements(c.policy::jsonb -> 'apps') entry,
              jsonb_array_elements(entry -> 'runsAs') target where target ->> 'kind' = 'profile')`,
          [mapping],
        );
        yield* sql.unsafe(
          `update "mcpGrant" g set policy = jsonb_set(g.policy::jsonb, '{apps}',
              ${convertedApps("g.policy::jsonb", "targets", false)})::text
            where g.policy::jsonb ->> 'kind' = 'tools' and exists (
              select 1 from jsonb_array_elements(g.policy::jsonb -> 'apps') entry,
                jsonb_array_elements(case when entry ? 'targets' then entry -> 'targets' else '[]'::jsonb end) target
              where target ->> 'kind' = 'profile')`,
          [mapping],
        );
        yield* sql`insert into executor_local_steps (name) values (${step})`;
      }),
    );
  });
