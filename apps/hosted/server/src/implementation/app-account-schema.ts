/** App account links, for both scopes, with members' links converted once from the profiles they replace. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Every existing account an enabled profile that is not being removed selected, plain and many()
 * alike, with `copy`: the reserved ID of the app copy its account set became (see SDK 4.0.13 and
 * `executor_profile_app_copies`), or null when it stays with the app. `plain` marks the account a
 * plain requirement used, as SDK 4.0.13 reads it: the first existing account selected for a
 * requirement that is not many() in the app's active deployment, or, without one, a single
 * selection.
 */
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

/**
 * Every existing account an enabled profile that is not being removed selected, with the
 * requirement it selected it for, its position in that selection and `plain`: whether the
 * requirement is not many() in the app's active deployment (or, for an app without one, the
 * selection was a single account). `copy` is as in {@link profileAccounts}.
 */
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

/**
 * Runs-as targets naming a profile become targets for the accounts that profile linked, which
 * still exist, on the app its account set went to: `copy` is null for the app itself, or a copy's
 * reserved ID. A profile that selected none, or was disabled or removed, contributes no target;
 * an empty result permits nothing. Only the app's own entry keeps its other targets.
 */
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

/**
 * A policy's app entries with profile targets converted: each entry for its own app, then, after
 * it, a clone of the entry for each app copy one of its profiles' account sets became, with only
 * that profile's accounts as targets and the entry's tool and event scopes. `targets` names the
 * entry's target list, `keep` the entries that stay.
 */
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

/** Whether a policy's app entries name a profile in `targets`. */
const namesProfile = (apps: string, targets: string) => `exists (
  select 1 from jsonb_array_elements(${apps}) entry,
    jsonb_array_elements(case when entry ? '${targets}' then entry -> '${targets}' else '[]'::jsonb end) target
  where target ->> 'kind' = 'profile')`;

/**
 * Hosted step 9. Caller holds the hosted migration lock, in the transaction that ran SDK schema
 * 4.0.13, which keeps `executor_installations` for this step and planned app copies in
 * `executor_profile_app_copies`.
 *
 * `hosted_app_account_links` holds every account linked to an app requirement: an app link has no
 * `subject` and is used for every caller and the app's background work; a user link names the
 * member who uses it. Links are keyed by requirement in both scopes. A plain requirement has at most
 * one link per app (and subject), kept by the link routes under the app's lock; many() any number.
 * Removing the app or the member removes their links. Deleting an account removes its links, but
 * an account with an app link is refused first (`AccountLinkedToApp`, and the account removal hook
 * under the account's row lock). `linked_by` is the member who made the link, kept as history.
 *
 * - One user link per app, requirement, account and member from every enabled profile that is not
 *   being removed and whose account set stays with the app, the requirement taken from the
 *   profile's selection: several such profiles of one member and app had the same plain accounts,
 *   and their many() selections become their union. A plain requirement links only the account
 *   it used, its first existing one. Apps, accounts and users that no longer exist are skipped, as
 *   are accounts of another organization. The default Executor app's managed key was such a
 *   profile selection, so it converts the same way; a deleted key has no account row and is not
 *   recreated. A copy's links are added when data step `10_profile_app_copies` creates it. No app
 *   links are created.
 * - Pending connections drop the profile from their target. Step 7 made the target required, so
 *   each keeps its app and requirement; completing it links the new account to that requirement
 *   for its creator, who had to own the profile. A connection for a profile whose account set
 *   became a copy targets the copy, so it never replaces the member's account of the app.
 * - Scoped MCP connections and grants that ran as a profile run as its accounts instead, on the
 *   app or on the copy its account set became (a copy's entry is a clone of the app's, listed
 *   after it). Access is only ever narrowed, never widened:
 *   - A connection app whose targets convert to none is removed from the connection's policy. An
 *     app a connection does not list is excluded, so it permits nothing there. A connection left
 *     with no apps stays, permitting nothing, until its owner edits or revokes it.
 *   - A grant entry whose listed targets convert to none keeps an empty `targets` list. A listed
 *     target list is exact and an empty one permits no tool, event or account (see
 *     `permissionTargets` in `@executor-js/authorization`); it is never dropped, which would
 *     leave the entry unrestricted. A clone for a copy is added only with an account to target.
 *     Entries without `targets` never named a profile and are unchanged.
 *   - Before the copy exists, an entry for it permits nothing.
 * - SDK 4.0.13 made each profile's schedule its member's schedule of the app or of a copy. One
 *   whose member has left the organization, or whose user no longer exists, is paused, and a copy
 *   will not resume it: each of its runs would be refused. It is kept, not deleted, so its
 *   settings and history remain readable.
 *
 * The previous server keeps serving until the new one deploys. It never reads links; it refuses
 * to complete connections and to authorize grants that this step changed.
 */
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
  // One app link per app, requirement and account, and one user link per member besides.
  yield* sql`create unique index if not exists hosted_app_account_links_app
    on hosted_app_account_links (app, requirement, account) where subject is null`;
  yield* sql`create unique index if not exists hosted_app_account_links_user
    on hosted_app_account_links (app, subject, requirement, account) where subject is not null`;
  yield* sql`create index if not exists hosted_app_account_links_account
    on hosted_app_account_links (account, app)`;
  // Dated by their oldest profile, so many() links keep the order the profiles were made in.
  // The previous Worker serves until the new one replaces it: a profile it changes in those
  // seconds is not copied. Accepted for one short rollout rather than syncing the two.
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
