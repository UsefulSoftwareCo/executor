/** Every saved account becomes one member's own; app links give one credential to everyone. */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** Shared accounts of an organization with no member left, which no member can own. */
export class SharedAccountsWithoutMember extends Schema.TaggedError<SharedAccountsWithoutMember>()(
  "SharedAccountsWithoutMember",
  { accounts: Schema.Number },
) {
  override get message() {
    return `${this.accounts} shared accounts belong to organizations with no members, so no member can own them.`;
  }
}

/**
 * The member each shared account goes to: its creator while they are a member of its
 * organization, else the organization's oldest owner, else its oldest admin, else its oldest
 * member. Null when the organization has no member.
 */
const newOwners = `select p.account_id, coalesce(
    (select m."userId" from member m
      where m."organizationId" = p.organization_id and m."userId" = p.creator_id),
    (select m."userId" from member m where m."organizationId" = p.organization_id
      order by m.role = 'owner' desc, m.role = 'admin' desc, m."createdAt", m.id limit 1)
  ) as owner
  from hosted_account_access p
  where p.kind = 'shared'`;

/**
 * What happens to each user link of a shared account that is not its new owner's, read while the
 * accounts are still shared. A link becomes an app link (`converted`, or `covered` when that app
 * link already exists) only when all of these hold:
 *
 * - It serves the member's calls now, by the running server's rule for shared accounts: the
 *   member is in the account's organization, the account is the app owner's, it is shared with
 *   everyone, and its requirement is a user requirement of the app's active version for the
 *   account's provider. A group-shared account already serves nobody's user links.
 * - The active version declares exactly one app requirement for that provider, and it is many().
 *   `appLink` checks the same requirement fields (`addLink`), so the app link is one an editor
 *   could make. A plain app requirement is left alone: linking would replace its account for every
 *   caller, and several members' links could not all fill it.
 *
 * Otherwise it is `deleted`, with the first reason that applied.
 */
const userLinkPlan = `select l.app, l.requirement, l.subject, l.account, l.linked_by, l.created_at,
    to_jsonb(l) as row,
    case
      when not usable then 'unusable'
      when required is null then 'no_version'
      when jsonb_typeof(required -> l.requirement) is distinct from 'object'
        or coalesce(required -> l.requirement ->> 'scope', 'user') <> 'user'
        or required -> l.requirement ->> 'provider' is distinct from a.provider then 'not_required'
      when candidates.app_requirements = 0 then 'no_app_requirement'
      when candidates.many = 0 then 'plain_app_requirement'
      when candidates.many > 1 then 'ambiguous'
    end as reason,
    candidates.target
  from hosted_app_account_links l
  join (${newOwners}) o on o.account_id = l.account
  join hosted_account_access p on p.account_id = l.account
  join executor_accounts a on a.id = l.account
  join executor_apps app on app.id = l.app
  left join executor_deployments d on d.id = app.active_deployment
  cross join lateral (select
      case when jsonb_typeof(d.requirements::jsonb -> 'accounts') = 'object'
        then d.requirements::jsonb -> 'accounts' end as required,
      a.owner = app.owner and a.owner = 'organization:' || p.organization_id
        and p.audience = 'everyone'
        and exists (select 1 from member m
          where m."organizationId" = p.organization_id and m."userId" = l.subject) as usable
    ) version
  cross join lateral (select count(*) as app_requirements,
      count(*) filter (where r.value ->> 'cardinality' = 'many') as many,
      min(r.key) filter (where r.value ->> 'cardinality' = 'many') as target
    from jsonb_each(coalesce(version.required, '{}'::jsonb)) r
    where jsonb_typeof(r.value) = 'object' and r.value ->> 'scope' = 'app'
      and r.value ->> 'provider' = a.provider) candidates
  where l.subject is not null and l.subject <> o.owner`;

const Run = Schema.Tuple([Schema.Struct({ run: Schema.String })]);

/**
 * Hosted step 12. Caller holds the hosted migration lock. Turns every shared account, including
 * one an older server left with the `groups` audience, into one member's personal account:
 *
 * - Its owner is its creator while still a member of its organization, otherwise the
 *   organization's oldest owner (then admin, then member), so an account whose creator left keeps
 *   serving its app links.
 * - Its app links are unchanged. They keep serving every caller while the owner is a member.
 * - Its owner's user links are unchanged. Every other member's user link to it is removed: they
 *   cannot use another member's account. Where the app's active version takes accounts of that
 *   provider for everyone (see {@link userLinkPlan}), the account is linked to that requirement
 *   for everyone first, so the member's calls keep it, as they keep the app's own links. A webhook
 *   source running as such a member moves to the new app link, as `appLink` moves it; otherwise it
 *   stops at its next resolution, as when a member loses access.
 * - Its `hosted_account_groups` rows are removed and its revision changes.
 *
 * A pending sign-in saved to create a shared account has its access record removed, so it is
 * refused and its creator starts again, as step 10 did for group-shared ones.
 *
 * Every change is recorded in `hosted_personal_accounts_backup` under one run ID before it is
 * made, and the changes are made from those records, so nothing changes that is not recorded.
 *
 * Fails and changes nothing while a shared account belongs to an organization with no member.
 *
 * The previous server keeps serving until the new one deploys, and reads personal accounts as
 * this step leaves them. A shared account it creates in those seconds stays shared, and the new
 * server lets nobody use it. The `shared` kind, `audience`, `destination` and
 * `hosted_account_groups` stay until a later release, once no running server reads them.
 */
export const migratePersonalAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orphans = yield* sql`select count(*)::int as accounts
    from (${sql.literal(newOwners)}) chosen where chosen.owner is null`;
  const [{ accounts }] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ accounts: Schema.Number })]),
  )(orphans);
  if (accounts > 0) {
    const error = new SharedAccountsWithoutMember({ accounts });
    // The migration failure keeps only error tags, so log the count here.
    yield* Effect.logError(error.message);
    return yield* error;
  }
  // One-off record of what this step changed, so it can be audited and undone without a database
  // restore: one row per changed row, `row` holding it as it was before the step (an inserted app
  // link or webhook source as inserted). Never read by the server. See notes/storage.md for the
  // restore and for when the table is dropped. A rerun on a database that ran it adds a new run.
  yield* sql`create table if not exists hosted_personal_accounts_backup (
    id bigint generated always as identity primary key,
    run text not null,
    entry text not null check (entry in
      ('account', 'user_link', 'app_link', 'webhook_source', 'account_group', 'connection_access')),
    account_id text,
    outcome text not null,
    reason text,
    target text,
    new_owner text,
    row jsonb not null,
    recorded_at timestamp with time zone not null default now()
  )`;
  yield* sql`create index if not exists hosted_personal_accounts_backup_run
    on hosted_personal_accounts_backup (run, entry)`;
  const [{ run }] = yield* Schema.decodeUnknownEffect(Run)(
    yield* sql`select gen_random_uuid()::text as run`,
  );
  const owners = sql.literal(`(${newOwners})`);
  // `from`/`using` and the start of `where` over this run's records of one kind, as `b`.
  const recorded = (entry: string) =>
    sql`hosted_personal_accounts_backup b where b.run = ${run} and b.entry = ${entry}`;

  // Record everything while the accounts are still shared.
  yield* sql`insert into hosted_personal_accounts_backup
      (run, entry, account_id, outcome, new_owner, row)
    select ${run}, 'account', p.account_id, 'personal', o.owner, to_jsonb(p)
    from hosted_account_access p join ${owners} o on o.account_id = p.account_id`;
  yield* sql`insert into hosted_personal_accounts_backup
      (run, entry, account_id, outcome, reason, target, row)
    select ${run}, 'user_link', plan.account,
      case when plan.reason is not null then 'deleted'
        when exists (select 1 from hosted_app_account_links k
          where k.app = plan.app and k.requirement = plan.target and k.account = plan.account
            and k.subject is null) then 'covered'
        else 'converted' end,
      plan.reason, case when plan.reason is null then plan.target end, plan.row
    from (${sql.literal(userLinkPlan)}) plan`;
  yield* sql`insert into hosted_personal_accounts_backup (run, entry, account_id, outcome, row)
    select ${run}, 'account_group', g.account_id, 'deleted', to_jsonb(g)
    from hosted_account_groups g join ${owners} o on o.account_id = g.account_id`;
  yield* sql`insert into hosted_personal_accounts_backup (run, entry, outcome, row)
    select ${run}, 'connection_access', 'deleted', to_jsonb(c)
    from hosted_connection_access c where c.destination ->> 'kind' = 'shared'`;

  // One app link per app, requirement and account, linked by the member whose user link was the
  // oldest. They are dated now, in the order of those user links, so they follow the app's
  // existing links, as links made by hand do.
  yield* sql`with converted as (
      select b.row ->> 'app' as app, b.target, b.account_id,
        (array_agg(b.row ->> 'subject' order by (b.row ->> 'created_at')::timestamptz,
          b.row ->> 'subject'))[1] as linked_by,
        min((b.row ->> 'created_at')::timestamptz) as first
      from ${recorded("user_link")} and b.outcome = 'converted'
      group by b.row ->> 'app', b.target, b.account_id
    ), inserted as (
      insert into hosted_app_account_links
        (app, requirement, subject, account, linked_by, created_at)
      select app, target, null, account_id, linked_by,
        now() + row_number() over (order by first, app, account_id) * interval '1 microsecond'
      from converted
      on conflict (app, requirement, account) where subject is null do nothing
      returning *
    )
    insert into hosted_personal_accounts_backup
      (run, entry, account_id, outcome, target, row)
    select ${run}, 'app_link', i.account, 'inserted', i.requirement, to_jsonb(i) from inserted i`;

  // Each account with a new app link serves it from the app's own source, as `addLink` saves
  // through `webhooks.link`: no actor, new intent the source worker reconciles. Its configuration
  // is kept and not recorded.
  const linkedSources = sql`(select distinct b.row ->> 'app' as app, b.account_id as account
    from ${recorded("app_link")}) n`;
  yield* sql`insert into hosted_personal_accounts_backup (run, entry, account_id, outcome, row)
    select ${run}, 'webhook_source', s.account, 'relinked', jsonb_build_object('id', s.id,
      'app', s.app, 'account', s.account, 'actor', s.actor, 'status', s.status,
      'revision', s.revision)
    from executor_webhook_sources s join ${linkedSources} on n.app = s.app and n.account = s.account`;
  yield* sql`update executor_webhook_sources s
    set actor = null, accounts = '{}', status = 'pending', failure = null, retries = 0,
      revision = s.revision + 1
    from ${linkedSources} where n.app = s.app and n.account = s.account`;
  yield* sql`with created as (
      insert into executor_webhook_sources (id, app, owner, account, actor, accounts, config,
        revision, status, failure, reconciled_deployment, lease, lease_until, created_at, retries)
      select 'src_' || gen_random_uuid()::text, n.app, app.owner, n.account, null, '{}', '{}', 1,
        'pending', null, null, null, to_timestamp(0), now(), 0
      from ${linkedSources} join executor_apps app on app.id = n.app
      on conflict (app, account) do nothing
      returning id, app, account
    )
    insert into hosted_personal_accounts_backup (run, entry, account_id, outcome, row)
    select ${run}, 'webhook_source', c.account, 'created',
      jsonb_build_object('id', c.id, 'app', c.app, 'account', c.account)
    from created c`;

  // Remove and convert exactly what was recorded.
  yield* sql`delete from hosted_app_account_links l using ${recorded("user_link")}
    and l.app = b.row ->> 'app' and l.requirement = b.row ->> 'requirement'
    and l.subject = b.row ->> 'subject' and l.account = b.account_id`;
  yield* sql`delete from hosted_account_groups g using ${recorded("account_group")}
    and g.account_id = b.account_id and g.group_id = b.row ->> 'group_id'`;
  yield* sql`delete from hosted_connection_access c using ${recorded("connection_access")}
    and c.connection_id = b.row ->> 'connection_id'`;
  yield* sql`update hosted_account_access p
    set kind = 'personal', personal_user_id = b.new_owner, audience = null,
      revision = gen_random_uuid()::text
    from ${recorded("account")} and p.account_id = b.account_id and p.kind = 'shared'`;
});
