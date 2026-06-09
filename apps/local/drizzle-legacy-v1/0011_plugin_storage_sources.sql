CREATE TABLE IF NOT EXISTS `openapi_source` (`id` text NOT NULL, `scope_id` text NOT NULL, `name` text NOT NULL, `spec` text NOT NULL, `source_url` text, `base_url` text, `oauth2` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `openapi_operation` (`id` text NOT NULL, `scope_id` text NOT NULL, `source_id` text NOT NULL, `binding` text NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `openapi_source_header` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `openapi_source_query_param` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `openapi_source_spec_fetch_header` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `openapi_source_spec_fetch_query_param` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `graphql_source` (`id` text NOT NULL, `scope_id` text NOT NULL, `name` text NOT NULL, `endpoint` text NOT NULL, `auth_kind` text NOT NULL DEFAULT 'none', `auth_connection_slot` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `graphql_source_header` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `graphql_source_query_param` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `graphql_operation` (`id` text NOT NULL, `scope_id` text NOT NULL, `source_id` text NOT NULL, `binding` text NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_source` (`id` text NOT NULL, `scope_id` text NOT NULL, `name` text NOT NULL, `config` text NOT NULL, `auth_kind` text NOT NULL DEFAULT 'none', `auth_header_name` text, `auth_header_slot` text, `auth_header_prefix` text, `auth_connection_slot` text, `auth_client_id_slot` text, `auth_client_secret_slot` text, `created_at` integer);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_source_header` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_source_query_param` (`id` text, `scope_id` text, `source_id` text, `name` text, `kind` text, `text_value` text, `slot_key` text, `prefix` text);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_binding` (`id` text NOT NULL, `scope_id` text NOT NULL, `source_id` text NOT NULL, `binding` text NOT NULL, `created_at` integer);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plugin_storage` (
  `id` text NOT NULL,
  `scope_id` text NOT NULL,
  `plugin_id` text NOT NULL,
  `collection` text NOT NULL,
  `key` text NOT NULL,
  `data` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_storage_scope_id_idx` ON `plugin_storage` (`scope_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_storage_plugin_id_collection_idx` ON `plugin_storage` (`plugin_id`, `collection`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_storage_key_idx` ON `plugin_storage` (`key`);
--> statement-breakpoint
INSERT OR REPLACE INTO `plugin_storage` (`id`, `scope_id`, `plugin_id`, `collection`, `key`, `data`, `created_at`, `updated_at`)
SELECT
  json_array('openapi', 'source', s.`id`),
  s.`scope_id`,
  'openapi',
  'source',
  s.`id`,
  json_object(
    'namespace', s.`id`,
    'scope', s.`scope_id`,
    'name', s.`name`,
    'config', json_patch(
      json_patch(
        json_patch(
          json_patch(
            json_patch(
              json_patch(
                json_object('spec', s.`spec`),
                CASE WHEN s.`source_url` IS NULL THEN json_object() ELSE json_object('sourceUrl', s.`source_url`) END
              ),
              CASE WHEN s.`base_url` IS NULL THEN json_object() ELSE json_object('baseUrl', s.`base_url`) END
            ),
            CASE WHEN h.`headers` IS NULL THEN json_object() ELSE json_object('headers', json(h.`headers`)) END
          ),
          CASE WHEN q.`queryParams` IS NULL THEN json_object() ELSE json_object('queryParams', json(q.`queryParams`)) END
        ),
        CASE WHEN sfh.`headers` IS NULL AND sfq.`queryParams` IS NULL THEN json_object() ELSE json_object('specFetchCredentials', json_patch(
          CASE WHEN sfh.`headers` IS NULL THEN json_object() ELSE json_object('headers', json(sfh.`headers`)) END,
          CASE WHEN sfq.`queryParams` IS NULL THEN json_object() ELSE json_object('queryParams', json(sfq.`queryParams`)) END
        )) END
      ),
      CASE WHEN s.`oauth2` IS NULL THEN json_object() ELSE json_object('oauth2', json(s.`oauth2`)) END
    )
  ),
  unixepoch('now') * 1000,
  unixepoch('now') * 1000
FROM `openapi_source` s
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `headers`
  FROM `openapi_source_header`
  GROUP BY `scope_id`, `source_id`
) h ON h.`scope_id` = s.`scope_id` AND h.`source_id` = s.`id`
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `queryParams`
  FROM `openapi_source_query_param`
  GROUP BY `scope_id`, `source_id`
) q ON q.`scope_id` = s.`scope_id` AND q.`source_id` = s.`id`
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `headers`
  FROM `openapi_source_spec_fetch_header`
  GROUP BY `scope_id`, `source_id`
) sfh ON sfh.`scope_id` = s.`scope_id` AND sfh.`source_id` = s.`id`
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `queryParams`
  FROM `openapi_source_spec_fetch_query_param`
  GROUP BY `scope_id`, `source_id`
) sfq ON sfq.`scope_id` = s.`scope_id` AND sfq.`source_id` = s.`id`;
--> statement-breakpoint
INSERT OR REPLACE INTO `plugin_storage` (`id`, `scope_id`, `plugin_id`, `collection`, `key`, `data`, `created_at`, `updated_at`)
SELECT json_array('openapi', 'operation', o.`id`), o.`scope_id`, 'openapi', 'operation', o.`id`, json_object('toolId', o.`id`, 'sourceId', o.`source_id`, 'binding', json(o.`binding`)), unixepoch('now') * 1000, unixepoch('now') * 1000
FROM `openapi_operation` o;
--> statement-breakpoint
INSERT OR REPLACE INTO `plugin_storage` (`id`, `scope_id`, `plugin_id`, `collection`, `key`, `data`, `created_at`, `updated_at`)
SELECT
  json_array('graphql', 'source', s.`id`),
  s.`scope_id`,
  'graphql',
  'source',
  s.`id`,
  json_object(
    'namespace', s.`id`,
    'scope', s.`scope_id`,
    'name', s.`name`,
    'endpoint', s.`endpoint`,
    'headers', COALESCE(json(h.`headers`), json_object()),
    'queryParams', COALESCE(json(q.`queryParams`), json_object()),
    'auth', CASE WHEN s.`auth_kind` = 'oauth2' AND s.`auth_connection_slot` IS NOT NULL THEN json_object('kind', 'oauth2', 'connectionSlot', s.`auth_connection_slot`) ELSE json_object('kind', 'none') END
  ),
  unixepoch('now') * 1000,
  unixepoch('now') * 1000
FROM `graphql_source` s
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `headers`
  FROM `graphql_source_header`
  GROUP BY `scope_id`, `source_id`
) h ON h.`scope_id` = s.`scope_id` AND h.`source_id` = s.`id`
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `queryParams`
  FROM `graphql_source_query_param`
  GROUP BY `scope_id`, `source_id`
) q ON q.`scope_id` = s.`scope_id` AND q.`source_id` = s.`id`;
--> statement-breakpoint
INSERT OR REPLACE INTO `plugin_storage` (`id`, `scope_id`, `plugin_id`, `collection`, `key`, `data`, `created_at`, `updated_at`)
SELECT json_array('graphql', 'operation', o.`id`), o.`scope_id`, 'graphql', 'operation', o.`id`, json_object('toolId', o.`id`, 'sourceId', o.`source_id`, 'binding', json(o.`binding`)), unixepoch('now') * 1000, unixepoch('now') * 1000
FROM `graphql_operation` o;
--> statement-breakpoint
INSERT OR REPLACE INTO `plugin_storage` (`id`, `scope_id`, `plugin_id`, `collection`, `key`, `data`, `created_at`, `updated_at`)
SELECT
  json_array('mcp', 'source', s.`id`),
  s.`scope_id`,
  'mcp',
  'source',
  s.`id`,
  json_object(
    'namespace', s.`id`,
    'scope', s.`scope_id`,
    'name', s.`name`,
    'config', CASE WHEN json_extract(s.`config`, '$.transport') = 'remote' THEN json_patch(
      json_patch(
        json_patch(
          json(s.`config`),
          CASE WHEN h.`headers` IS NULL THEN json_object() ELSE json_object('headers', json(h.`headers`)) END
        ),
        CASE WHEN q.`queryParams` IS NULL THEN json_object() ELSE json_object('queryParams', json(q.`queryParams`)) END
      ),
      json_object('auth',
        CASE
          WHEN s.`auth_kind` = 'header' THEN json_object('kind', 'header', 'headerName', COALESCE(s.`auth_header_name`, ''), 'secretSlot', s.`auth_header_slot`, 'prefix', s.`auth_header_prefix`)
          WHEN s.`auth_kind` = 'oauth2' THEN json_object('kind', 'oauth2', 'connectionSlot', s.`auth_connection_slot`, 'clientIdSlot', s.`auth_client_id_slot`, 'clientSecretSlot', s.`auth_client_secret_slot`)
          ELSE json_object('kind', 'none')
        END
      )
    ) ELSE json(s.`config`) END
  ),
  unixepoch('now') * 1000,
  unixepoch('now') * 1000
FROM `mcp_source` s
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `headers`
  FROM `mcp_source_header`
  GROUP BY `scope_id`, `source_id`
) h ON h.`scope_id` = s.`scope_id` AND h.`source_id` = s.`id`
LEFT JOIN (
  SELECT `scope_id`, `source_id`, json_group_object(`name`, CASE WHEN `kind` = 'text' THEN json_quote(`text_value`) ELSE json_object('kind', 'binding', 'slot', `slot_key`, 'prefix', `prefix`) END) AS `queryParams`
  FROM `mcp_source_query_param`
  GROUP BY `scope_id`, `source_id`
) q ON q.`scope_id` = s.`scope_id` AND q.`source_id` = s.`id`;
--> statement-breakpoint
INSERT OR REPLACE INTO `plugin_storage` (`id`, `scope_id`, `plugin_id`, `collection`, `key`, `data`, `created_at`, `updated_at`)
SELECT json_array('mcp', 'binding', b.`id`), b.`scope_id`, 'mcp', 'binding', b.`id`, json_object('namespace', b.`source_id`, 'toolId', b.`id`, 'binding', json(b.`binding`)), COALESCE(b.`created_at`, unixepoch('now') * 1000), unixepoch('now') * 1000
FROM `mcp_binding` b;
--> statement-breakpoint
DROP TABLE IF EXISTS `openapi_source`;
--> statement-breakpoint
DROP TABLE IF EXISTS `openapi_operation`;
--> statement-breakpoint
DROP TABLE IF EXISTS `openapi_source_header`;
--> statement-breakpoint
DROP TABLE IF EXISTS `openapi_source_query_param`;
--> statement-breakpoint
DROP TABLE IF EXISTS `openapi_source_spec_fetch_header`;
--> statement-breakpoint
DROP TABLE IF EXISTS `openapi_source_spec_fetch_query_param`;
--> statement-breakpoint
DROP TABLE IF EXISTS `graphql_source`;
--> statement-breakpoint
DROP TABLE IF EXISTS `graphql_source_header`;
--> statement-breakpoint
DROP TABLE IF EXISTS `graphql_source_query_param`;
--> statement-breakpoint
DROP TABLE IF EXISTS `graphql_operation`;
--> statement-breakpoint
DROP TABLE IF EXISTS `mcp_source`;
--> statement-breakpoint
DROP TABLE IF EXISTS `mcp_source_header`;
--> statement-breakpoint
DROP TABLE IF EXISTS `mcp_source_query_param`;
--> statement-breakpoint
DROP TABLE IF EXISTS `mcp_binding`;
