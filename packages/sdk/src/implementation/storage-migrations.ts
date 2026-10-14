/** Current baseline and the upgrades required by existing version 4 databases. */
import { fumadb } from "fumadb-effect";
import { Effect, Schema } from "effect";
import { generateMigrationFromSchema } from "fumadb-effect/migration";
import { schema, type AnySchema, type CustomMigrationFn } from "fumadb-effect/schema";
import {
  boundedReadIndexes,
  eventIndexes,
  toolSearchIndexes,
  toolSearchTargetIndex,
  version408Schema,
  version409Schema,
  version4010Schema,
  version4012Schema,
  version4013Tables,
  version4014Tables,
  appScheduleIndex,
  scopedRunKeyIndex,
  version402Tables,
  version403Tables,
  version404Tables,
  version405Tables,
  version406Tables,
  version407Tables,
  version4Tables,
  storedOAuthClientIndexes,
  storedOAuthClientIssuerIndexes,
} from "./storage-schema.ts";

/** Indexes the 4.0.1 step added. Released steps never change; later indexes join their own step. */
export const storageIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name)",
  "CREATE INDEX IF NOT EXISTS executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
] as const;

/**
 * The background indexes of 4.0.13. Start and subscription keys are unique per app and actor; a
 * subscription key only among subscriptions that have not stopped, so a source can register a key
 * again beside its stopped history. The retired profile column stays in those keys until it is
 * dropped, so keys saved per profile before 4.0.13 remain distinct. A member has one copy of each
 * schedule declaration.
 */
const actorIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(actor, ''), COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(actor, ''), COALESCE(installation, ''), subscription_key) WHERE status <> 'stopped'",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_copy ON executor_schedules (app, name, actor)",
] as const;

/** 4.0.13 indexes that 4.0.14 kept; it replaced the start key index with `scopedRunKeyIndex`. */
const [, webhooksContextKey, schedulesCopy] = actorIndexes;
/** 4.0.1 indexes that later versions kept unchanged. */
const [, , , schedulesDue, scheduledRunsPending, scheduledRunsOwner] = storageIndexes;
/** 4.0.9 tool search indexes that 4.0.13 kept; the per-profile listing index serves only older servers. */
const [toolSearchListing, toolSearchTerms, , toolSearchDefinitionsListing] = toolSearchIndexes;

/** Every index of the current layout, for a new database. Upgrades add each in its own step. */
export const currentIndexes = [
  scopedRunKeyIndex,
  webhooksContextKey,
  schedulesCopy,
  appScheduleIndex,
  schedulesDue,
  scheduledRunsPending,
  scheduledRunsOwner,
  ...eventIndexes,
  toolSearchListing,
  toolSearchTerms,
  toolSearchDefinitionsListing,
  toolSearchTargetIndex,
  ...storedOAuthClientIndexes,
  ...boundedReadIndexes,
  ...storedOAuthClientIssuerIndexes,
] as const;

/** Versions built by {@link indexOnlyVersion}. */
const indexOnlyVersions = new WeakSet<AnySchema>();

/**
 * A version that only builds indexes: it reuses `previous`'s tables and relations and runs
 * `indexes`, so it cannot express a table change. `trailingIndexVersions` checks that `previous`
 * is the version before it.
 */
export const indexOnlyVersion = <Version extends string, Previous extends AnySchema>(
  previous: Previous,
  version: Version,
  indexes: ReadonlyArray<string>,
) => {
  const entry = schema({
    version,
    tables: previous.tables as Previous["tables"],
    up: () => Effect.succeed(indexes.map((sql) => ({ type: "custom" as const, sql }))),
  });
  indexOnlyVersions.add(entry);
  return entry;
};

/** An index-only version whose tables differ from the version before it, or that has none. */
export class IndexOnlyVersionChangesTables extends Schema.TaggedError<IndexOnlyVersionChangesTables>()(
  "IndexOnlyVersionChangesTables",
  { version: Schema.String },
) {
  override get message() {
    return `Storage version ${this.version} is index-only, but its tables differ from the version before it. Build it with indexOnlyVersion from that version.`;
  }
}

/**
 * The index-only versions after the last version that changes tables. `CREATE INDEX` blocks writes
 * to its table until the enclosing transaction commits, so a host that does more work in that
 * transaction runs these at its end (`migrateTables`, then `migrate`). Every table exists before
 * them, so that work sees the current layout. Throws `IndexOnlyVersionChangesTables` when an
 * index-only version's tables are not exactly its predecessor's: deferring it would run that work
 * before its tables exist.
 */
export const trailingIndexVersions = (schemas: ReadonlyArray<AnySchema>): ReadonlySet<string> => {
  schemas.forEach((entry, index) => {
    if (!indexOnlyVersions.has(entry)) return;
    const previous = schemas[index - 1];
    const changes =
      previous === undefined
        ? undefined
        : generateMigrationFromSchema(previous, entry, {
            provider: "postgresql",
            dropUnusedTables: true,
            dropUnusedColumns: true,
          });
    if (changes === undefined || changes.length > 0)
      throw new IndexOnlyVersionChangesTables({ version: entry.version });
  });
  return new Set(
    schemas
      .slice(schemas.findLastIndex((entry) => !indexOnlyVersions.has(entry)) + 1)
      .map((entry) => entry.version),
  );
};
/**
 * Each profile that is not being removed, with what decides its app after 4.0.13, in the temporary
 * `executor_profile_sets`:
 *
 * - `plain`: its account for each plain requirement, as JSON text sorted by requirement, with
 *   null for none or a deleted account. Plain requirements are those of the app's active
 *   deployment, or, for an app without one, the profile's single selections.
 * - `many`: every existing account it selected for a many() requirement, as `requirement/id`.
 * - `linked`: the existing accounts it selected, plain and many(), in selection order.
 * - `complete`: every plain requirement has an existing account. Links are kept per requirement,
 *   so plain requirements of one provider keep different accounts as they were.
 * - `position`: its place among its member's profiles of the app, oldest first, which named it
 *   ("Default", then "Profile N") when it had no name.
 * - `copy`: null when its account set is the one of its member's oldest enabled profile (or oldest
 *   profile, when none is enabled), which stays with the app; otherwise the reserved ID of the copy
 *   of the app its account set becomes, one per member and set.
 */
const profileSets = [
  "DROP TABLE IF EXISTS executor_profile_sets",
  `CREATE TEMP TABLE executor_profile_sets AS
   WITH profiles AS (
     SELECT i.id, i.app, i.owner, i.subject, i.name, i.enabled, i.created_at, i.webhook_config,
         i.accounts::jsonb AS selected, d.requirements::jsonb -> 'accounts' AS required,
         row_number() OVER (PARTITION BY i.app, i.subject ORDER BY i.created_at, i.id) AS position
       FROM executor_installations i
       JOIN executor_apps a ON a.id = i.app
       LEFT JOIN executor_deployments d ON d.id = a.active_deployment
       WHERE i.status NOT IN ('removing', 'removed')
   ), slots AS (
     SELECT p.id, r.key AS slot, r.value ->> 'cardinality' = 'many' AS many
       FROM profiles p CROSS JOIN jsonb_each(p.required) r WHERE p.required IS NOT NULL
     UNION ALL
     SELECT p.id, b.key, jsonb_typeof(b.value) = 'array'
       FROM profiles p CROSS JOIN jsonb_each(p.selected) b WHERE p.required IS NULL
   ), chosen AS (
     SELECT s.id, s.slot, s.many, e.account, e.ord
       FROM slots s JOIN profiles p ON p.id = s.id
       CROSS JOIN LATERAL jsonb_array_elements_text(CASE jsonb_typeof(p.selected -> s.slot)
           WHEN 'array' THEN p.selected -> s.slot
           WHEN 'string' THEN jsonb_build_array(p.selected -> s.slot)
           ELSE '[]'::jsonb END) WITH ORDINALITY e(account, ord)
       JOIN executor_accounts c ON c.id = e.account
   )
   SELECT p.id, p.app, p.owner, p.subject, p.name, p.enabled, p.created_at, p.webhook_config,
       p.position,
       COALESCE((SELECT jsonb_agg(jsonb_build_array(s.slot, (
             SELECT c.account FROM chosen c WHERE c.id = s.id AND c.slot = s.slot
               ORDER BY c.ord LIMIT 1)) ORDER BY s.slot COLLATE "C")::text
           FROM slots s WHERE s.id = p.id AND NOT s.many), '[]') AS plain,
       COALESCE((SELECT array_agg(c.slot || '/' || c.account) FROM chosen c
           WHERE c.id = p.id AND c.many), '{}') AS many,
       COALESCE((SELECT jsonb_agg(c.account ORDER BY c.slot COLLATE "C", c.ord) FROM chosen c
           WHERE c.id = p.id), '[]'::jsonb) AS linked,
       NOT EXISTS (SELECT 1 FROM slots s WHERE s.id = p.id AND NOT s.many
           AND NOT EXISTS (SELECT 1 FROM chosen c WHERE c.id = s.id AND c.slot = s.slot))
         AS complete,
       NULL::text AS copy
     FROM profiles p`,
  `UPDATE executor_profile_sets p
     SET copy = 'app_' || substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-' || substr(h, 13, 4)
         || '-' || substr(h, 17, 4) || '-' || substr(h, 21, 12)
     FROM (SELECT q.id, md5(q.app || '/' || q.subject || '/' || q.plain) AS h
         FROM executor_profile_sets q) hashed
     WHERE hashed.id = p.id AND p.plain <> (
       SELECT o.plain FROM executor_profile_sets o
         WHERE o.app = p.app AND o.subject = p.subject
         ORDER BY o.enabled DESC, o.created_at, o.id LIMIT 1)`,
  // One copy per member and account set, named after its oldest enabled (else oldest) profile.
  // Only enabled profiles link accounts, oldest first and the set's plain accounts last. Data step
  // 10 links each to the requirements its profiles selected it for. A disabled profile never ran.
  `INSERT INTO executor_profile_app_copies (id, app, owner, subject, label, profiles, accounts,
       webhook_config, enable, status, created_at)
     SELECT DISTINCT ON (p.copy) p.copy, p.app, p.owner, p.subject,
         left(COALESCE(NULLIF(btrim(p.name), ''),
           CASE WHEN p.position = 1 THEN 'Default' ELSE 'Profile ' || p.position END), 128),
         (SELECT json_agg(g.id ORDER BY g.created_at, g.id) FROM executor_profile_sets g
           WHERE g.copy = p.copy),
         COALESCE((SELECT json_agg(ids.account ORDER BY ids.plain, ids.first, ids.account)
           FROM (SELECT e.account, min(g.created_at) AS first,
                 EXISTS (SELECT 1 FROM jsonb_array_elements(p.plain::jsonb) k
                   WHERE k ->> 1 = e.account) AS plain
               FROM executor_profile_sets g CROSS JOIN jsonb_array_elements_text(g.linked) e(account)
               WHERE g.copy = p.copy AND g.enabled GROUP BY e.account) ids), '[]'::json),
         p.webhook_config::json, '[]'::json, 'pending', p.created_at
       FROM executor_profile_sets p WHERE p.copy IS NOT NULL
       ORDER BY p.copy, p.enabled DESC, p.created_at, p.id`,
] as const;

/**
 * Each schedule of a profile, with the app it belongs to now (`target`: the app, or the copy its
 * profile's account set became) and whether it may stay enabled, in the temporary
 * `executor_profile_schedules`. It may not when its profile was disabled or removed, when a plain
 * requirement of its account set has no account, or when its many() accounts would widen: the
 * accounts its member links to a many() requirement of the target are those every enabled profile
 * with the same account set selected for that requirement, and a schedule runs with all of them,
 * which none of the profiles its merged schedules came from had. Only a merged schedule that was
 * enabled and `usable` shows a profile it ran with: a paused schedule, or one of a disabled profile,
 * did not run with its profile's accounts, so its selection witnesses nothing. Each requirement is
 * judged on its own links, as runs resolve them.
 */
const profileSchedules = [
  "DROP TABLE IF EXISTS executor_profile_schedules",
  `CREATE TEMP TABLE executor_profile_schedules AS
   SELECT s.id, s.name, i.subject AS actor, COALESCE(p.copy, s.app) AS target,
       COALESCE(p.enabled AND p.complete, false) AS usable, s.enabled, p.many
     FROM executor_schedules s
     JOIN executor_installations i ON i.id = s.installation
     LEFT JOIN executor_profile_sets p ON p.id = i.id`,
  // What each many() requirement runs with on the target: the accounts the member's enabled
  // profiles with the account set it stands for selected for that requirement, as `requirement/id`,
  // which become the member's links to it. Accounts selected for another requirement, plain or
  // many(), are not linked to it. Widened when no merged schedule that was enabled and usable had
  // all of them in its own profile.
  "DROP TABLE IF EXISTS executor_profile_widened",
  `CREATE TEMP TABLE executor_profile_widened AS
   SELECT ps.target, ps.name, ps.actor
     FROM executor_profile_schedules ps
     CROSS JOIN LATERAL (SELECT COALESCE(array_agg(DISTINCT m.link), '{}') AS accounts
         FROM executor_profile_sets g CROSS JOIN unnest(g.many) m(link)
         WHERE g.enabled AND g.subject = ps.actor
           AND (g.copy = ps.target OR (g.copy IS NULL AND g.app = ps.target))) linked
     GROUP BY ps.target, ps.name, ps.actor, linked.accounts
     HAVING NOT COALESCE(bool_or(ps.many @> linked.accounts) FILTER (WHERE ps.enabled AND ps.usable),
       true)`,
] as const;

/**
 * One schedule per app, declaration and member. Schedules a member's profiles had for one
 * declaration of the same app merge into one: keep the running, then enabled, then oldest
 * profile's row, enabled if any of them was and none of the reasons above pauses it.
 */
const rankedSchedules = `WITH ranked AS (
  SELECT s.id, first_value(s.id) OVER w AS keep, row_number() OVER w AS rank
    FROM executor_schedules s LEFT JOIN executor_installations i ON i.id = s.installation
    WINDOW w AS (PARTITION BY s.app, s.name, s.actor
      ORDER BY (s.active_run IS NOT NULL) DESC, s.enabled DESC, i.created_at ASC NULLS FIRST, s.id ASC))`;

/**
 * Version 4.0.13 converts the SDK rows that named a profile, in the migration transaction:
 *
 * - A member whose profiles of one app selected different accounts for a plain requirement keeps
 *   the app for the account set of their oldest enabled profile (oldest profile when none is),
 *   and each other account set becomes a copy of the app, planned in
 *   `executor_profile_app_copies` under a reserved app ID; data step `10_profile_app_copies`
 *   creates it. Profiles with the same account set stay together. Every profile not being removed
 *   counts; disabled ones link no accounts.
 * - Each profile's schedule becomes its member's schedule of the app or of the copy its account
 *   set became. A member's schedules of one declaration merge into one, enabled if one was; the
 *   others' run history moves to it. Schedules of disabled or removed profiles, of account sets
 *   without an account for a plain requirement, and those whose many() accounts would widen (see
 *   `executor_profile_widened`) are paused. A copy's schedules wait under its reserved ID, paused;
 *   the copy resumes the ones listed in its plan.
 * - Workflow runs and webhook subscriptions record their profile's subject as the actor. Their
 *   saved accounts are unchanged; a subscription's actor and accounts are also the ones its
 *   registration ran as, which removing it uses. Workflow runs stay with the app: they run on its
 *   deployments.
 * - Each account an active profile whose account set stays with the app selected becomes a
 *   webhook source for its app, from the app's oldest such profile, with that profile's webhook
 *   configuration. Profiles of deleted apps and selections of deleted accounts add none. Sources
 *   start pending and adopt or replace the profile's managed registrations. A copy gets its own
 *   sources when the data step links its accounts.
 * - Subscriptions of disabled or removed profiles, of profiles whose account set becomes a copy,
 *   and of accounts no source took over, stop delivering: they are marked stopping. Their
 *   accounts' managed registrations are queued for removal as removing sources, which the source
 *   worker unregisters and then deletes.
 * - A pending connection for a profile whose account set becomes a copy targets the copy, so
 *   completing it links its account there, not to the app.
 * - Tool search listings, which were kept per app and profile, are marked superseded now. They
 *   are derived from listings and have no account-set target, so this server never searches them
 *   or supersedes a target with them; the previous server keeps searching and reviving its own
 *   until it stops. Writing an app's next listing removes them once superseded for as long as an
 *   execution may still search them, and removing the app removes them at once. Their cost is
 *   reading each listing again.
 *
 * App data is not converted: an app's database is keyed by its ID, shared by all its profiles, so
 * a copy starts with an empty one.
 *
 * Connection targets keep the profile keys the previous server wrote (`installation`,
 * `cardinality`, `selection`): that server decodes them while it completes connections. This
 * server's target is the app and requirement, and its decoder ignores the other keys.
 *
 * `executor_installations` and the profile columns stay, for the product's own conversion and for
 * the previous server, which keeps serving until the new one deploys. Triggers fill in the actor
 * and registration of rows that server inserts meanwhile, and park a schedule of a profile whose
 * account set becomes a copy under the copy, paused; only it names a profile. A later version
 * drops the triggers, the profile columns and keys, the per-profile tool search index and the
 * table once no running server reads them.
 */
const version4013Conversion = [
  ...profileSets,
  ...profileSchedules,
  // A profile's schedule ran as its subject, the member the schedule keeps.
  `UPDATE executor_schedules s SET actor = ps.actor, app = ps.target,
       enabled = s.enabled AND ps.usable AND NOT EXISTS (SELECT 1 FROM executor_profile_widened w
         WHERE w.target = ps.target AND w.name = ps.name AND w.actor = ps.actor)
     FROM executor_profile_schedules ps WHERE ps.id = s.id`,
  `UPDATE executor_schedules s SET next_at = NULL FROM executor_profile_schedules ps
     WHERE ps.id = s.id AND NOT s.enabled`,
  `UPDATE executor_scheduled_runs r SET app = s.app FROM executor_schedules s
     WHERE s.id = r.schedule_id AND r.app <> s.app`,
  // Keep enabled what one of the merged schedules had enabled.
  `WITH merged AS (SELECT s.app, s.name, s.actor, bool_or(s.enabled) AS enabled,
       min(s.next_at) FILTER (WHERE s.enabled) AS next_at
       FROM executor_schedules s GROUP BY s.app, s.name, s.actor HAVING count(*) > 1),
   ${rankedSchedules.slice("WITH ".length)}
   UPDATE executor_schedules s SET enabled = merged.enabled,
       next_at = CASE WHEN merged.enabled THEN COALESCE(s.next_at, merged.next_at) END
     FROM merged, ranked
     WHERE ranked.id = s.id AND ranked.rank = 1
       AND merged.app = s.app AND merged.name = s.name AND merged.actor = s.actor`,
  `${rankedSchedules}
   UPDATE executor_scheduled_runs r SET schedule_id = ranked.keep
     FROM ranked WHERE r.schedule_id = ranked.id AND ranked.rank > 1`,
  `${rankedSchedules}
   DELETE FROM executor_schedules s USING ranked WHERE s.id = ranked.id AND ranked.rank > 1`,
  // A copy's schedules wait paused under its reserved ID; the copy resumes the enabled ones.
  `UPDATE executor_profile_app_copies c SET enable = COALESCE((
       SELECT json_agg(s.id ORDER BY s.id) FROM executor_schedules s
         WHERE s.app = c.id AND s.enabled), '[]'::json)`,
  `UPDATE executor_schedules s SET enabled = false, next_at = NULL
     FROM executor_profile_app_copies c WHERE c.id = s.app AND s.enabled`,
  "DROP INDEX IF EXISTS executor_schedules_context_name",
  `UPDATE executor_workflow_runs r SET actor = i.subject
     FROM executor_installations i WHERE i.id = r.installation`,
  "DROP INDEX IF EXISTS executor_workflow_runs_context_key",
  `UPDATE executor_webhooks w SET actor = i.subject
     FROM executor_installations i WHERE i.id = w.installation`,
  // A profile's registrations ran as its subject with its full selection; removing them uses both.
  `UPDATE executor_webhooks SET registered_actor = actor, registered_accounts = accounts
     WHERE status <> 'stopped'`,
  "DROP INDEX IF EXISTS executor_webhooks_context_key",
  `INSERT INTO executor_webhook_sources (id, app, owner, account, actor, accounts, config, revision,
       status, failure, reconciled_deployment, lease, lease_until, created_at)
     SELECT DISTINCT ON (p.app, linked.account)
         'src_' || md5(p.app || '/' || linked.account), p.app, p.owner, linked.account, p.subject,
         '{}'::json, p.webhook_config::json, 1, 'pending', NULL, NULL, NULL, p.created_at,
         p.created_at
       FROM executor_profile_sets p
       CROSS JOIN jsonb_array_elements_text(p.linked) linked(account)
       WHERE p.enabled AND p.copy IS NULL
       ORDER BY p.app, linked.account, p.created_at, p.id
     ON CONFLICT DO NOTHING`,
  // A profile's subscriptions that no source took over would keep delivering as its subject.
  `UPDATE executor_webhooks w SET status = 'stopping'
     FROM executor_installations i
     WHERE i.id = w.installation AND w.status NOT IN ('stopping', 'disabled', 'stopped')
       AND (NOT i.enabled OR i.status IN ('removing', 'removed')
         OR EXISTS (SELECT 1 FROM executor_profile_sets p WHERE p.id = i.id AND p.copy IS NOT NULL)
         OR NOT EXISTS (SELECT 1 FROM executor_webhook_sources s
           WHERE s.app = w.app AND s.account = w.source_account))`,
  `INSERT INTO executor_webhook_sources (id, app, owner, account, actor, accounts, config, revision,
       status, failure, reconciled_deployment, lease, lease_until, created_at)
     SELECT DISTINCT ON (w.app, w.source_account)
         'src_' || md5(w.app || '/' || w.source_account), w.app, w.owner, w.source_account,
         w.actor, '{}'::json, '{}'::json, 1, 'removing', NULL, NULL, NULL, w.created_at,
         w.created_at
       FROM executor_webhooks w
       JOIN executor_apps app ON app.id = w.app
       JOIN executor_accounts a ON a.id = w.source_account
       WHERE w.installation IS NOT NULL AND w.status = 'stopping'
         AND w.subscription_key LIKE 'setup-%'
       ORDER BY w.app, w.source_account, w.created_at, w.id
     ON CONFLICT DO NOTHING`,
  `UPDATE executor_account_connections c
     SET target = jsonb_set(c.target::jsonb, '{app}', to_jsonb(p.copy))::json
     FROM executor_profile_sets p
     WHERE p.copy IS NOT NULL AND c.target IS NOT NULL
       AND p.id = COALESCE(c.target::jsonb ->> 'installation', c.target::jsonb ->> 'profile')`,
  `CREATE OR REPLACE FUNCTION executor_profile_actor() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.installation IS NOT NULL THEN
       SELECT subject INTO NEW.actor FROM executor_installations WHERE id = NEW.installation;
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE OR REPLACE FUNCTION executor_profile_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.installation IS NOT NULL THEN
       SELECT subject INTO NEW.actor FROM executor_installations WHERE id = NEW.installation;
       NEW.registered_actor := NEW.actor;
       NEW.registered_accounts := NEW.accounts;
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE OR REPLACE FUNCTION executor_profile_schedule() RETURNS trigger
   LANGUAGE plpgsql AS $$
   DECLARE
     parked text;
   BEGIN
     IF NEW.installation IS NOT NULL THEN
       SELECT subject INTO NEW.actor FROM executor_installations WHERE id = NEW.installation;
       SELECT c.id INTO parked FROM executor_profile_app_copies c
         WHERE c.status = 'pending' AND c.profiles::jsonb ? NEW.installation;
       IF parked IS NOT NULL THEN
         NEW.app := parked;
         NEW.enabled := false;
         NEW.next_at := NULL;
       END IF;
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER executor_workflow_runs_profile_actor BEFORE INSERT ON executor_workflow_runs
     FOR EACH ROW EXECUTE FUNCTION executor_profile_actor()`,
  `CREATE TRIGGER executor_webhooks_profile_actor BEFORE INSERT ON executor_webhooks
     FOR EACH ROW EXECUTE FUNCTION executor_profile_webhook()`,
  `CREATE TRIGGER executor_schedules_profile_actor BEFORE INSERT ON executor_schedules
     FOR EACH ROW EXECUTE FUNCTION executor_profile_schedule()`,
  `UPDATE executor_tool_search_listings
     SET superseded = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
     WHERE superseded IS NULL`,
  "DROP TABLE executor_profile_widened",
  "DROP TABLE executor_profile_schedules",
  "DROP TABLE executor_profile_sets",
  toolSearchTargetIndex,
  ...actorIndexes,
] as const;

/** A shipped version 4 layout, with the same foreign keys as the current schema. */
const version4 = <Version extends string>(version: Version, up?: CustomMigrationFn) =>
  schema({
    version,
    tables: version4Tables,
    ...(up === undefined ? {} : { up }),
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  });

/** Version 4 is the oldest supported layout. Append future compatible upgrades here. */
export const storageSchemas = [
  version4("4.0.0"),
  version4("4.0.1", () =>
    Effect.succeed(storageIndexes.map((sql) => ({ type: "custom" as const, sql }))),
  ),
  // Additive: existing accounts start at generation 0 and the running server ignores the column.
  schema({
    version: "4.0.2",
    tables: version402Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a new account checks table that the running server never reads.
  schema({
    version: "4.0.3",
    tables: version403Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable account description; the running server neither reads nor writes it.
  schema({
    version: "4.0.4",
    tables: version404Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable column the running server never names. Existing accounts read as
  // connected without hosts, which is how they behave before this version.
  schema({
    version: "4.0.5",
    tables: version405Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable check message the running server never names. Existing checks have none.
  schema({
    version: "4.0.6",
    tables: version406Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: three event tables and their indexes, which the running server never names.
  schema({
    version: "4.0.7",
    tables: version407Tables,
    up: ({ auto }) =>
      auto.pipe(
        Effect.map((operations) => [
          ...operations,
          ...eventIndexes.map((sql) => ({ type: "custom" as const, sql })),
        ]),
      ),
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Deletes connections without a target, then requires one. The running server has written a
  // target on every connection since #2135 and reads the column as nullable, so it is unaffected.
  version408Schema,
  // Additive: three tool search tables and their indexes, which the running server never names.
  version409Schema,
  // Additive: a stored OAuth clients table and its indexes, which the running server never names.
  // The old saved-client table stays, so the running server keeps using it; a data step moves its
  // clients (see `6_stored_oauth_clients`).
  version4010Schema,
  // Additive: three indexes; the running server's queries are unchanged.
  indexOnlyVersion(version4010Schema, "4.0.11", boundedReadIndexes),
  // Additive for the running server: a nullable `issuer` on stored clients and its index, and
  // `provider` made nullable on stored clients and their credentials. The running server writes a
  // provider on every row and never names `issuer`. The new server's data step
  // `8_oauth_clients_by_issuer` records each existing client's issuer; until then those clients
  // keep working through their pre-4.0.12 credentials identity, and are offered to no sign-in.
  version4012Schema,
  // Additive columns and tables, then the profile conversion. The previous server keeps every
  // column it reads; it cannot add a second schedule of one member for a declaration, and the
  // tool search listings it writes have no target, so this server never takes them for its own.
  schema({
    version: "4.0.13",
    tables: version4013Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
    up: ({ auto }) =>
      auto.pipe(
        Effect.map((operations) => [
          ...operations,
          ...version4013Conversion.map((sql) => ({ type: "custom" as const, sql })),
        ]),
      ),
  }),
  // Additive for the running server: schedules and webhook sources may have no actor, and one
  // index keeps a declaration's app schedule unique. Only this server writes a row without an
  // actor, so the running server reads none before it is replaced. Start keys become unique per
  // scope too: every existing run, and every run the running server inserts, is a user run, so the
  // new index holds them exactly as the one it replaces did, and is built before that one drops.
  schema({
    version: "4.0.14",
    tables: version4014Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
    up: ({ auto }) =>
      auto.pipe(
        Effect.map((operations) => [
          ...operations,
          { type: "custom" as const, sql: appScheduleIndex },
          { type: "custom" as const, sql: scopedRunKeyIndex },
          {
            type: "custom" as const,
            sql: "DROP INDEX IF EXISTS executor_workflow_runs_context_key",
          },
        ]),
      ),
  }),
] as const;

/** Checked when this module loads, so a misbuilt index-only version fails every host's start. */
export const trailingStorageIndexVersions = trailingIndexVersions(storageSchemas);

/** Versioned persistence factory; constructing it does not touch a database. */
export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas,
});
