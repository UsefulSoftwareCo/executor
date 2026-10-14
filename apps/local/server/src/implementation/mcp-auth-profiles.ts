/**
 * MCP connections and grants saved before profiles were removed may run as a profile. This step
 * converts them once, in the MCP auth database: a profile target becomes targets for the existing
 * accounts that enabled profile selected. A profile that was disabled, removed or selected none
 * permits nothing, and a connection app left without targets is removed from its connection. A
 * profile whose account set became a copy of its app (planned by SDK 4.0.13) permits its accounts
 * on a clone of the entry for that copy's reserved app ID instead.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

const ProfileAccount = Schema.Struct({
  profile: Schema.String,
  account: Schema.String,
  /** The reserved ID of the copy the profile's account set became, if it became one. */
  copy: Schema.NullOr(Schema.String),
});
export type ProfileAccount = typeof ProfileAccount.Type;

/**
 * Every existing account an enabled profile that is not being removed selected, with the copy
 * planned for it, read from the executor database, which keeps `executor_installations` and
 * `executor_profile_app_copies` for product conversions.
 */
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

/**
 * Run-as targets in `targets`, with each profile replaced by its accounts from `$1`. Profiles that
 * became a copy permit nothing here; see {@link convertedApps}.
 */
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

/**
 * The app entries of `policy` with their `field` targets converted, in order. An entry naming
 * profiles that became a copy is followed by a clone of it for each such copy's reserved app ID,
 * targeting those profiles' accounts. An entry without `field` is kept as it is; with `prune`,
 * an entry left without targets is dropped.
 */
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

/**
 * Convert the MCP auth database's profile targets once, recording the step in the same
 * transaction. `accounts` is read only when the step has not run.
 */
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
