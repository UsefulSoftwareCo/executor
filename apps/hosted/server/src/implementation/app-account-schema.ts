import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const profileAccounts = `select i.id as profile, i.app, i.subject, i.created_at, linked.account,
    linked.plain,
    (select c.id from executor_profile_app_copies c where c.profiles::jsonb ? i.id) as copy
  from executor_installations i
  left join executor_apps app on app.id = i.app
  left join executor_deployments d on d.id = app.active_deployment
  cross join lateral (
    select selected.account, bool_or(selected.plain) as plain from (
      select a.id as account, row_number() over (partition by b.key order by e.ord) = 1
          and case when d.requirements is null then jsonb_typeof(b.value) = 'string'
            else d.requirements::jsonb -> 'accounts' -> b.key ->> 'cardinality' = 'one' end
          as plain
        from jsonb_each(i.accounts::jsonb) b
        cross join lateral jsonb_array_elements_text(case jsonb_typeof(b.value)
            when 'array' then b.value
            when 'string' then jsonb_build_array(b.value)
            else '[]'::jsonb end) with ordinality e(account, ord)
        join executor_accounts a on a.id = e.account
    ) selected group by selected.account
  ) linked
  where i.enabled and i.status not in ('removing', 'removed')`;

const profileLinks = `select i.app, i.subject, i.created_at, b.key as requirement, a.id as account,
    row_number() over (partition by i.id, b.key order by e.ord) as position,
    case when d.requirements is null then jsonb_typeof(b.value) = 'string'
      else d.requirements::jsonb -> 'accounts' -> b.key ->> 'cardinality' = 'one' end as plain,
    (select c.id from executor_profile_app_copies c where c.profiles::jsonb ? i.id) as copy
  from executor_installations i
  left join executor_apps app on app.id = i.app
  left join executor_deployments d on d.id = app.active_deployment
  cross join lateral jsonb_each(i.accounts::jsonb) b
  cross join lateral jsonb_array_elements_text(case jsonb_typeof(b.value)
      when 'array' then b.value
      when 'string' then jsonb_build_array(b.value)
      else '[]'::jsonb end) with ordinality e(account, ord)
  join executor_accounts a on a.id = e.account
  where i.enabled and i.status not in ('removing', 'removed')`;

const convertedTargets = (targets: string, copy: string) => `(
  select coalesce(jsonb_agg(distinct target), '[]'::jsonb) from (
    select t.value as target from jsonb_array_elements(${targets}) t(value)
      where t.value ->> 'kind' <> 'profile' and ${copy} is null
    union
    select jsonb_build_object('kind', 'account', 'id', p.account)
      from jsonb_array_elements(${targets}) t(value)
      join (${profileAccounts}) p on p.profile = t.value ->> 'id'
      join executor_accounts a on a.id = p.account
      where t.value ->> 'kind' = 'profile' and p.copy is not distinct from ${copy}
  ) converted)`;

const convertedEntries = (apps: string, targets: string, keep: string) => `(
  select coalesce(jsonb_agg(converted.entry order by converted.position, converted.copy nulls first),
      '[]'::jsonb) from (
    select entry.position, null::text as copy, case when entry.value ? '${targets}'
        then jsonb_set(entry.value, '{${targets}}', ${convertedTargets(`entry.value -> '${targets}'`, "null::text")})
        else entry.value end as entry
      from jsonb_array_elements(${apps}) with ordinality entry(value, position)
    union all
    select entry.position, plan.id, jsonb_set(jsonb_set(entry.value, '{app}', to_jsonb(plan.id)),
        '{${targets}}', ${convertedTargets(`entry.value -> '${targets}'`, "plan.id")})
      from jsonb_array_elements(${apps}) with ordinality entry(value, position)
      join executor_profile_app_copies plan on plan.app = entry.value ->> 'app' and exists (
        select 1 from jsonb_array_elements(entry.value -> '${targets}') t
          where t ->> 'kind' = 'profile' and plan.profiles::jsonb ? (t ->> 'id'))
  ) converted where ${keep})`;

const namesProfile = (apps: string, targets: string) => `exists (
  select 1 from jsonb_array_elements(${apps}) entry,
    jsonb_array_elements(case when entry ? '${targets}' then entry -> '${targets}' else '[]'::jsonb end) target
  where target ->> 'kind' = 'profile')`;

export const migrateAppAccountLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_app_account_links (
    app text not null references executor_apps(id) on delete cascade,
    requirement text not null,
    subject text references "user"(id) on delete cascade,
    account text not null references executor_accounts(id) on delete cascade,
    linked_by text not null,
    created_at timestamp with time zone not null default now()
  )`;
  yield* sql`create unique index if not exists hosted_app_account_links_app
    on hosted_app_account_links (app, requirement, account) where subject is null`;
  yield* sql`create unique index if not exists hosted_app_account_links_user
    on hosted_app_account_links (app, subject, requirement, account) where subject is not null`;
  yield* sql`create index if not exists hosted_app_account_links_account
    on hosted_app_account_links (account, app)`;
  yield* sql`insert into hosted_app_account_links
      (app, requirement, subject, account, linked_by, created_at)
    select p.app, p.requirement, p.subject, p.account, p.subject, min(p.created_at)
      from (${sql.literal(profileLinks)}) p
      join executor_apps app on app.id = p.app
      join executor_accounts a on a.id = p.account and a.owner = app.owner
      join "user" u on u.id = p.subject
      where p.copy is null and (p.plain is not true or p.position = 1)
      group by p.app, p.requirement, p.subject, p.account
    on conflict do nothing`;
  const member = (actor: string, owner: string) => `exists (
    select 1 from member m
      where m."userId" = ${actor} and 'organization:' || m."organizationId" = ${owner})`;
  yield* sql`update executor_schedules s set enabled = false, next_at = null
    where s.enabled and not ${sql.literal(member("s.actor", "s.owner"))}`;
  yield* sql`update executor_profile_app_copies c set enable = coalesce((
      select json_agg(e.id order by e.id) from json_array_elements_text(c.enable) e(id)
        join executor_schedules s on s.id = e.id
        where ${sql.literal(member("s.actor", "c.owner"))}), '[]'::json)`;
  yield* sql`update hosted_connection_access h
    set target = jsonb_set(h.target, '{app}', to_jsonb(c.id))
    from executor_profile_app_copies c
    where h.target ? 'installation' and c.profiles::jsonb ? (h.target ->> 'installation')`;
  yield* sql`update hosted_connection_access set target = target - 'installation'
    where target ? 'installation'`;
  yield* sql`update "mcpConnection" c set policy = jsonb_set(c.policy::jsonb, '{apps}',
      ${sql.literal(convertedEntries("c.policy::jsonb -> 'apps'", "runsAs", "jsonb_array_length(converted.entry -> 'runsAs') > 0"))})::text
    where ${sql.literal(namesProfile("c.policy::jsonb -> 'apps'", "runsAs"))}`;
  yield* sql`update "mcpGrant" g set policy = jsonb_set(g.policy::jsonb, '{apps}',
      ${sql.literal(convertedEntries("g.policy::jsonb -> 'apps'", "targets", "(converted.copy is null or jsonb_array_length(converted.entry -> 'targets') > 0)"))})::text
    where g.policy::jsonb ->> 'kind' = 'tools'
      and ${sql.literal(namesProfile("g.policy::jsonb -> 'apps'", "targets"))}`;
});
