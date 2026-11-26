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
  version4015Tables,
  version4017Tables,
  providerIdentityIndex,
  eventSelectionIndexes,
  version4018Tables,
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
  queueReadIndexes,
} from "./storage-schema.ts";

export const storageIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name)",
  "CREATE INDEX IF NOT EXISTS executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
] as const;

const actorIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(actor, ''), COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(actor, ''), COALESCE(installation, ''), subscription_key) WHERE status <> 'stopped'",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_copy ON executor_schedules (app, name, actor)",
] as const;

const [, webhooksContextKey, schedulesCopy] = actorIndexes;
const [, , , schedulesDue, scheduledRunsPending, scheduledRunsOwner] = storageIndexes;
const [toolSearchListing, toolSearchTerms, , toolSearchDefinitionsListing] = toolSearchIndexes;

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
  ...queueReadIndexes,
  ...eventSelectionIndexes,
  providerIdentityIndex,
] as const;

const indexOnlyVersions = new WeakSet<AnySchema>();

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

export class IndexOnlyVersionChangesTables extends Schema.TaggedError<IndexOnlyVersionChangesTables>()(
  "IndexOnlyVersionChangesTables",
  { version: Schema.String },
) {
  override get message() {
    return `Storage version ${this.version} is index-only, but its tables differ from the version before it. Build it with indexOnlyVersion from that version.`;
  }
}

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

const profileSchedules = [
  "DROP TABLE IF EXISTS executor_profile_schedules",
  `CREATE TEMP TABLE executor_profile_schedules AS
   SELECT s.id, s.name, i.subject AS actor, COALESCE(p.copy, s.app) AS target,
       COALESCE(p.enabled AND p.complete, false) AS usable, s.enabled, p.many
     FROM executor_schedules s
     JOIN executor_installations i ON i.id = s.installation
     LEFT JOIN executor_profile_sets p ON p.id = i.id`,
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

const rankedSchedules = `WITH ranked AS (
  SELECT s.id, first_value(s.id) OVER w AS keep, row_number() OVER w AS rank
    FROM executor_schedules s LEFT JOIN executor_installations i ON i.id = s.installation
    WINDOW w AS (PARTITION BY s.app, s.name, s.actor
      ORDER BY (s.active_run IS NOT NULL) DESC, s.enabled DESC, i.created_at ASC NULLS FIRST, s.id ASC))`;

const version4013Conversion = [
  ...profileSets,
  ...profileSchedules,
  `UPDATE executor_schedules s SET actor = ps.actor, app = ps.target,
       enabled = s.enabled AND ps.usable AND NOT EXISTS (SELECT 1 FROM executor_profile_widened w
         WHERE w.target = ps.target AND w.name = ps.name AND w.actor = ps.actor)
     FROM executor_profile_schedules ps WHERE ps.id = s.id`,
  `UPDATE executor_schedules s SET next_at = NULL FROM executor_profile_schedules ps
     WHERE ps.id = s.id AND NOT s.enabled`,
  `UPDATE executor_scheduled_runs r SET app = s.app FROM executor_schedules s
     WHERE s.id = r.schedule_id AND r.app <> s.app`,
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

const version4015Schema = schema({
  version: "4.0.15",
  tables: version4015Tables,
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

const version4018Schema = schema({
  version: "4.0.18",
  tables: version4018Tables,
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});
export const storageSchemas = [
  version4("4.0.0"),
  version4("4.0.1", () =>
    Effect.succeed(storageIndexes.map((sql) => ({ type: "custom" as const, sql }))),
  ),
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
  version408Schema,
  version409Schema,
  version4010Schema,
  indexOnlyVersion(version4010Schema, "4.0.11", boundedReadIndexes),
  version4012Schema,
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
  version4015Schema,
  indexOnlyVersion(version4015Schema, "4.0.16", queueReadIndexes),
  schema({
    version: "4.0.17",
    tables: version4017Tables,
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
          ...eventSelectionIndexes.map((sql) => ({ type: "custom" as const, sql })),
        ]),
      ),
  }),
  version4018Schema,
  indexOnlyVersion(version4018Schema, "4.0.19", [providerIdentityIndex]),
] as const;

export const trailingStorageIndexVersions = trailingIndexVersions(storageSchemas);

export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas,
});
