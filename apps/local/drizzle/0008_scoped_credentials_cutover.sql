--
-- Slug-normalization staging table.
--
-- 0008 originally inlined a 41-deep `replace(replace(... lower(...) ...))`
-- chain everywhere it derived a slot_key from a header / param / oauth
-- scheme name. bun:sqlite's lemon parser stack overflows on that depth on
-- platforms with smaller thread stacks (notably the compiled CLI binary on
-- macOS), so we precompute slugs once into a temp table and reference them
-- via flat scalar subqueries below.
--
CREATE TEMP TABLE `__slug_norm` (
	`raw` text PRIMARY KEY,
	`slug` text NOT NULL DEFAULT ''
);--> statement-breakpoint

INSERT OR IGNORE INTO `__slug_norm` (`raw`)
SELECT DISTINCT `raw` FROM (
	SELECT h.`key` AS `raw` FROM `openapi_source` s, json_each(s.`headers`) h
		WHERE s.`headers` IS NOT NULL AND h.`type` = 'object'
	UNION
	SELECT json_extract(s.`oauth2`, '$.securitySchemeName') FROM `openapi_source` s
		WHERE s.`oauth2` IS NOT NULL
	UNION
	SELECT `name` FROM `openapi_source_query_param` WHERE `name` IS NOT NULL
	UNION
	SELECT `name` FROM `openapi_source_spec_fetch_header` WHERE `name` IS NOT NULL
	UNION
	SELECT `name` FROM `openapi_source_spec_fetch_query_param` WHERE `name` IS NOT NULL
	UNION
	SELECT `name` FROM `graphql_source_header` WHERE `name` IS NOT NULL
	UNION
	SELECT `name` FROM `graphql_source_query_param` WHERE `name` IS NOT NULL
	UNION
	SELECT `name` FROM `mcp_source_header` WHERE `name` IS NOT NULL
	UNION
	SELECT `name` FROM `mcp_source_query_param` WHERE `name` IS NOT NULL
) WHERE `raw` IS NOT NULL AND `raw` != '';--> statement-breakpoint

UPDATE `__slug_norm` SET `slug` = lower(trim(`raw`));--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, char(9), '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, char(10), '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, char(13), '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, ' ', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '_', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '.', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, ':', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '/', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '@', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '+', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '&', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '?', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '#', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '%', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '$', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, ',', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, ';', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '(', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, ')', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '[', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, ']', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '{', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '}', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '=', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '~', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '!', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, char(34), '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, char(39), '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, char(92), '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '|', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '*', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '<', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '>', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = replace(`slug`, '--', '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = trim(`slug`, '-');--> statement-breakpoint
UPDATE `__slug_norm` SET `slug` = CASE WHEN `slug` = '' THEN 'default' ELSE `slug` END;--> statement-breakpoint

-- local scoped credential/source-slot/OAuth cutover.
-- Squashes the PR-local migration chain into one runtime schema transition.
-- 0008_add_credential_binding.sql
CREATE TABLE `credential_binding` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_scope_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`connection_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `credential_binding_scope_id_idx` ON `credential_binding` (`scope_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_plugin_id_idx` ON `credential_binding` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_source_id_idx` ON `credential_binding` (`source_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_source_scope_id_idx` ON `credential_binding` (`source_scope_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_slot_key_idx` ON `credential_binding` (`slot_key`);--> statement-breakpoint
CREATE INDEX `credential_binding_kind_idx` ON `credential_binding` (`kind`);--> statement-breakpoint
CREATE INDEX `credential_binding_secret_id_idx` ON `credential_binding` (`secret_id`);--> statement-breakpoint
CREATE INDEX `credential_binding_connection_id_idx` ON `credential_binding` (`connection_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_openapi_source_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_scope_id` text NOT NULL,
	`target_scope_id` text NOT NULL,
	`slot` text NOT NULL,
	`kind` text NOT NULL,
	`secret_id` text,
	`connection_id` text,
	`text_value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_openapi_source_binding`("id", "source_id", "source_scope_id", "target_scope_id", "slot", "kind", "secret_id", "connection_id", "text_value", "created_at", "updated_at") SELECT "id", "source_id", "source_scope_id", "target_scope_id", "slot", "kind", "secret_id", "connection_id", "text_value", "created_at", "updated_at" FROM `openapi_source_binding`;--> statement-breakpoint
DROP TABLE `openapi_source_binding`;--> statement-breakpoint
ALTER TABLE `__new_openapi_source_binding` RENAME TO `openapi_source_binding`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `openapi_source_binding_source_id_idx` ON `openapi_source_binding` (`source_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_source_scope_id_idx` ON `openapi_source_binding` (`source_scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_target_scope_id_idx` ON `openapi_source_binding` (`target_scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_slot_idx` ON `openapi_source_binding` (`slot`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_secret_id_idx` ON `openapi_source_binding` (`secret_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_connection_id_idx` ON `openapi_source_binding` (`connection_id`);--> statement-breakpoint

-- 0009_migrate_openapi_source_bindings.sql
INSERT OR REPLACE INTO `credential_binding` (
	`id`,
	`scope_id`,
	`plugin_id`,
	`source_id`,
	`source_scope_id`,
	`slot_key`,
	`kind`,
	`text_value`,
	`secret_id`,
	`connection_id`,
	`created_at`,
	`updated_at`
)
SELECT
	json_array('openapi', `source_scope_id`, `source_id`, `slot`),
	`target_scope_id`,
	'openapi',
	`source_id`,
	`source_scope_id`,
	`slot`,
	`kind`,
	`text_value`,
	`secret_id`,
	`connection_id`,
	`created_at`,
	`updated_at`
FROM `openapi_source_binding`;--> statement-breakpoint
DROP TABLE `openapi_source_binding`;--> statement-breakpoint

-- 0010_openapi_credential_slots.sql
-- Convert OpenAPI's remaining direct credential references to source-owned
-- slot structure plus shared core credential_binding rows. Runtime code only
-- reads the final slot model; this migration is the one-shot bridge.

-- Existing header JSON may still contain SecretBackedValue objects. Preserve
-- the source-owned header names, move secret ids to credential_binding, and
-- rewrite each object to { kind: "binding", slot, prefix? }.
CREATE TEMP TABLE `__openapi_header_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__openapi_header_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	s.`scope_id`,
	s.`id`,
	'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default') AS `slot_key`
FROM `openapi_source` s, json_each(s.`headers`) h
WHERE s.`headers` IS NOT NULL
  AND h.`type` = 'object'
  AND json_extract(h.`value`, '$.kind') IS NULL
  AND json_extract(h.`value`, '$.secretId') IS NOT NULL;--> statement-breakpoint

DROP TABLE `__openapi_header_slot_preflight`;--> statement-breakpoint

WITH header_rows AS (
	SELECT
		s.`scope_id`,
		s.`id` AS `source_id`,
		h.`key` AS `name`,
		'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default') AS `slot_key`,
		json_extract(h.`value`, '$.secretId') AS `secret_id`
	FROM `openapi_source` s, json_each(s.`headers`) h
	WHERE s.`headers` IS NOT NULL
	  AND h.`type` = 'object'
	  AND json_extract(h.`value`, '$.kind') IS NULL
	  AND json_extract(h.`value`, '$.secretId') IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM header_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`slot_key`
);--> statement-breakpoint

UPDATE `openapi_source`
SET `headers` = (
	SELECT json_group_object(
		h.`key`,
		CASE
			WHEN h.`type` = 'object'
			  AND json_extract(h.`value`, '$.kind') IS NULL
			  AND json_extract(h.`value`, '$.secretId') IS NOT NULL
			  AND json_extract(h.`value`, '$.prefix') IS NOT NULL
				THEN json_object(
					'kind', 'binding',
					'slot', 'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default'),
					'prefix', json_extract(h.`value`, '$.prefix')
				)
			WHEN h.`type` = 'object'
			  AND json_extract(h.`value`, '$.kind') IS NULL
			  AND json_extract(h.`value`, '$.secretId') IS NOT NULL
				THEN json_object(
					'kind', 'binding',
					'slot', 'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default')
				)
			WHEN h.`type` IN ('object', 'array') THEN json(h.`value`)
			ELSE h.`value`
		END
	)
	FROM json_each(`openapi_source`.`headers`) h
)
WHERE `headers` IS NOT NULL;--> statement-breakpoint

-- OAuth2Auth JSON becomes OAuth2SourceConfig JSON plus explicit bindings for
-- the client id, optional client secret, and live connection id.
WITH oauth_rows AS (
	SELECT
		s.`scope_id`,
		s.`id` AS `source_id`,
		json_extract(s.`oauth2`, '$.securitySchemeName') AS `security_scheme_name`,
		'oauth2:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = json_extract(s.`oauth2`, '$.securitySchemeName')), 'default') || ':client-id' AS `client_id_slot`,
		json_extract(s.`oauth2`, '$.clientIdSecretId') AS `client_id_secret_id`,
		json_extract(s.`oauth2`, '$.connectionId') AS `connection_id`
	FROM `openapi_source` s
	WHERE s.`oauth2` IS NOT NULL
	  AND json_extract(s.`oauth2`, '$.connectionId') IS NOT NULL
	  AND json_extract(s.`oauth2`, '$.clientIdSecretId') IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`client_id_slot`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`client_id_slot`,
	'secret',
	NULL,
	r.`client_id_secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM oauth_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`client_id_slot`
);--> statement-breakpoint

WITH oauth_rows AS (
	SELECT
		s.`scope_id`,
		s.`id` AS `source_id`,
		'oauth2:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = json_extract(s.`oauth2`, '$.securitySchemeName')), 'default') || ':client-secret' AS `client_secret_slot`,
		json_extract(s.`oauth2`, '$.clientSecretSecretId') AS `client_secret_secret_id`
	FROM `openapi_source` s
	WHERE s.`oauth2` IS NOT NULL
	  AND json_extract(s.`oauth2`, '$.connectionId') IS NOT NULL
	  AND json_extract(s.`oauth2`, '$.clientSecretSecretId') IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`client_secret_slot`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`client_secret_slot`,
	'secret',
	NULL,
	r.`client_secret_secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM oauth_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`client_secret_slot`
);--> statement-breakpoint

WITH oauth_rows AS (
	SELECT
		s.`scope_id`,
		s.`id` AS `source_id`,
		'oauth2:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = json_extract(s.`oauth2`, '$.securitySchemeName')), 'default') || ':connection' AS `connection_slot`,
		json_extract(s.`oauth2`, '$.connectionId') AS `connection_id`
	FROM `openapi_source` s
	WHERE s.`oauth2` IS NOT NULL
	  AND json_extract(s.`oauth2`, '$.connectionId') IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`connection_slot`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`connection_slot`,
	'connection',
	NULL,
	NULL,
	r.`connection_id`,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM oauth_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`connection_slot`
);--> statement-breakpoint

UPDATE `openapi_source`
SET `oauth2` = json_object(
	'kind', 'oauth2',
	'securitySchemeName', json_extract(`oauth2`, '$.securitySchemeName'),
	'flow', json_extract(`oauth2`, '$.flow'),
	'tokenUrl', json_extract(`oauth2`, '$.tokenUrl'),
	'authorizationUrl', json_extract(`oauth2`, '$.authorizationUrl'),
	'issuerUrl', json_extract(`oauth2`, '$.issuerUrl'),
	'clientIdSlot', 'oauth2:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = json_extract(`oauth2`, '$.securitySchemeName')), 'default') || ':client-id',
	'clientSecretSlot',
		CASE
			WHEN json_extract(`oauth2`, '$.clientSecretSecretId') IS NULL THEN NULL
			ELSE 'oauth2:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = json_extract(`oauth2`, '$.securitySchemeName')), 'default') || ':client-secret'
		END,
	'connectionSlot', 'oauth2:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = json_extract(`oauth2`, '$.securitySchemeName')), 'default') || ':connection',
	'scopes', json(COALESCE(json_extract(`oauth2`, '$.scopes'), '[]'))
)
WHERE `oauth2` IS NOT NULL
  AND json_extract(`oauth2`, '$.connectionId') IS NOT NULL;--> statement-breakpoint

-- Child credential rows become source-owned binding slots.
CREATE TEMP TABLE `__openapi_query_param_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__openapi_query_param_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	r.`scope_id`,
	r.`source_id`,
	'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = r.`name`), 'default') AS `slot_key`
FROM `openapi_source_query_param` r
WHERE r.`kind` = 'secret' AND r.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__openapi_query_param_slot_preflight`;--> statement-breakpoint

WITH rows AS (
	SELECT
		r.`scope_id`,
		r.`source_id`,
		'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = r.`name`), 'default') AS `slot_key`,
		r.`secret_id`
	FROM `openapi_source_query_param` r
	WHERE r.`kind` = 'secret' AND r.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`slot_key`
);--> statement-breakpoint

ALTER TABLE `openapi_source_query_param` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `openapi_source_query_param` ADD `prefix` text;--> statement-breakpoint
UPDATE `openapi_source_query_param`
SET
	`slot_key` = 'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`kind` = 'binding'
WHERE `kind` = 'secret';--> statement-breakpoint
DROP INDEX `openapi_source_query_param_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `openapi_source_query_param` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `openapi_source_query_param` DROP COLUMN `secret_prefix`;--> statement-breakpoint

CREATE TEMP TABLE `__openapi_spec_fetch_header_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__openapi_spec_fetch_header_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	r.`scope_id`,
	r.`source_id`,
	'spec_fetch_header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = r.`name`), 'default') AS `slot_key`
FROM `openapi_source_spec_fetch_header` r
WHERE r.`kind` = 'secret' AND r.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__openapi_spec_fetch_header_slot_preflight`;--> statement-breakpoint

WITH rows AS (
	SELECT
		r.`scope_id`,
		r.`source_id`,
		'spec_fetch_header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = r.`name`), 'default') AS `slot_key`,
		r.`secret_id`
	FROM `openapi_source_spec_fetch_header` r
	WHERE r.`kind` = 'secret' AND r.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`slot_key`
);--> statement-breakpoint

ALTER TABLE `openapi_source_spec_fetch_header` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `openapi_source_spec_fetch_header` ADD `prefix` text;--> statement-breakpoint
UPDATE `openapi_source_spec_fetch_header`
SET
	`slot_key` = 'spec_fetch_header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`kind` = 'binding'
WHERE `kind` = 'secret';--> statement-breakpoint
DROP INDEX `openapi_source_spec_fetch_header_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `openapi_source_spec_fetch_header` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `openapi_source_spec_fetch_header` DROP COLUMN `secret_prefix`;--> statement-breakpoint

CREATE TEMP TABLE `__openapi_spec_fetch_query_param_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__openapi_spec_fetch_query_param_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	r.`scope_id`,
	r.`source_id`,
	'spec_fetch_query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = r.`name`), 'default') AS `slot_key`
FROM `openapi_source_spec_fetch_query_param` r
WHERE r.`kind` = 'secret' AND r.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__openapi_spec_fetch_query_param_slot_preflight`;--> statement-breakpoint

WITH rows AS (
	SELECT
		r.`scope_id`,
		r.`source_id`,
		'spec_fetch_query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = r.`name`), 'default') AS `slot_key`,
		r.`secret_id`
	FROM `openapi_source_spec_fetch_query_param` r
	WHERE r.`kind` = 'secret' AND r.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`slot_key`
);--> statement-breakpoint

ALTER TABLE `openapi_source_spec_fetch_query_param` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `openapi_source_spec_fetch_query_param` ADD `prefix` text;--> statement-breakpoint
UPDATE `openapi_source_spec_fetch_query_param`
SET
	`slot_key` = 'spec_fetch_query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`kind` = 'binding'
WHERE `kind` = 'secret';--> statement-breakpoint
DROP INDEX `openapi_source_spec_fetch_query_param_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `openapi_source_spec_fetch_query_param` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `openapi_source_spec_fetch_query_param` DROP COLUMN `secret_prefix`;--> statement-breakpoint

-- 0011_graphql_credential_slots.sql
-- Convert GraphQL's direct credential references to source-owned slot
-- structure plus shared core credential_binding rows. Runtime code only
-- reads the final slot model; this migration is the one-shot bridge.

ALTER TABLE `graphql_source` ADD `auth_connection_slot` text;--> statement-breakpoint

UPDATE `graphql_source`
SET `auth_connection_slot` = 'auth:oauth2:connection'
WHERE `auth_kind` = 'oauth2'
  AND `auth_connection_id` IS NOT NULL;--> statement-breakpoint

INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('graphql', s.`scope_id`, s.`id`, 'auth:oauth2:connection'),
	s.`scope_id`,
	'graphql',
	s.`id`,
	s.`scope_id`,
	'auth:oauth2:connection',
	'connection',
	NULL,
	NULL,
	s.`auth_connection_id`,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `graphql_source` s
WHERE s.`auth_kind` = 'oauth2'
  AND s.`auth_connection_id` IS NOT NULL;--> statement-breakpoint

DROP INDEX `graphql_source_auth_connection_id_idx`;--> statement-breakpoint
ALTER TABLE `graphql_source` DROP COLUMN `auth_connection_id`;--> statement-breakpoint

ALTER TABLE `graphql_source_header` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `graphql_source_header` ADD `prefix` text;--> statement-breakpoint

CREATE TEMP TABLE `__graphql_header_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__graphql_header_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	h.`scope_id`,
	h.`source_id`,
	'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`name`), 'default') AS `slot_key`
FROM `graphql_source_header` h
WHERE h.`kind` = 'secret'
  AND h.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__graphql_header_slot_preflight`;--> statement-breakpoint

WITH header_rows AS (
	SELECT
		h.`scope_id`,
		h.`source_id`,
		h.`name`,
		'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`name`), 'default') AS `slot_key`,
		h.`secret_id`,
		h.`secret_prefix`
	FROM `graphql_source_header` h
	WHERE h.`kind` = 'secret'
	  AND h.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('graphql', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'graphql',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM header_rows r;--> statement-breakpoint

UPDATE `graphql_source_header`
SET
	`kind` = 'binding',
	`slot_key` = 'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`text_value` = NULL
WHERE `kind` = 'secret'
  AND `secret_id` IS NOT NULL;--> statement-breakpoint

DROP INDEX `graphql_source_header_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `graphql_source_header` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `graphql_source_header` DROP COLUMN `secret_prefix`;--> statement-breakpoint

ALTER TABLE `graphql_source_query_param` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `graphql_source_query_param` ADD `prefix` text;--> statement-breakpoint

CREATE TEMP TABLE `__graphql_query_param_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__graphql_query_param_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	q.`scope_id`,
	q.`source_id`,
	'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = q.`name`), 'default') AS `slot_key`
FROM `graphql_source_query_param` q
WHERE q.`kind` = 'secret'
  AND q.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__graphql_query_param_slot_preflight`;--> statement-breakpoint

WITH query_param_rows AS (
	SELECT
		q.`scope_id`,
		q.`source_id`,
		q.`name`,
		'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = q.`name`), 'default') AS `slot_key`,
		q.`secret_id`,
		q.`secret_prefix`
	FROM `graphql_source_query_param` q
	WHERE q.`kind` = 'secret'
	  AND q.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('graphql', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'graphql',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM query_param_rows r;--> statement-breakpoint

UPDATE `graphql_source_query_param`
SET
	`kind` = 'binding',
	`slot_key` = 'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`text_value` = NULL
WHERE `kind` = 'secret'
  AND `secret_id` IS NOT NULL;--> statement-breakpoint

DROP INDEX `graphql_source_query_param_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `graphql_source_query_param` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `graphql_source_query_param` DROP COLUMN `secret_prefix`;--> statement-breakpoint

-- 0012_mcp_credential_slots.sql
-- Convert MCP direct credential references to source-owned slot structure
-- plus shared core credential_binding rows. Runtime code only reads the
-- final slot model; this migration is the one-shot bridge from old data.

ALTER TABLE `mcp_source` ADD `auth_header_slot` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_header_prefix` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_connection_slot` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_client_id_slot` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_client_secret_slot` text;--> statement-breakpoint

UPDATE `mcp_source`
SET
	`auth_header_slot` = 'auth:header',
	`auth_header_prefix` = `auth_secret_prefix`
WHERE `auth_kind` = 'header'
  AND `auth_secret_id` IS NOT NULL;--> statement-breakpoint

INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('mcp', s.`scope_id`, s.`id`, 'auth:header'),
	s.`scope_id`,
	'mcp',
	s.`id`,
	s.`scope_id`,
	'auth:header',
	'secret',
	NULL,
	s.`auth_secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `mcp_source` s
WHERE s.`auth_kind` = 'header'
  AND s.`auth_secret_id` IS NOT NULL;--> statement-breakpoint

UPDATE `mcp_source`
SET
	`auth_connection_slot` = 'auth:oauth2:connection',
	`auth_client_id_slot` = CASE
		WHEN `auth_client_id_secret_id` IS NOT NULL THEN 'auth:oauth2:client-id'
		ELSE NULL
	END,
	`auth_client_secret_slot` = CASE
		WHEN `auth_client_secret_secret_id` IS NOT NULL THEN 'auth:oauth2:client-secret'
		ELSE NULL
	END
WHERE `auth_kind` = 'oauth2'
  AND `auth_connection_id` IS NOT NULL;--> statement-breakpoint

INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('mcp', s.`scope_id`, s.`id`, 'auth:oauth2:connection'),
	s.`scope_id`,
	'mcp',
	s.`id`,
	s.`scope_id`,
	'auth:oauth2:connection',
	'connection',
	NULL,
	NULL,
	s.`auth_connection_id`,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `mcp_source` s
WHERE s.`auth_kind` = 'oauth2'
  AND s.`auth_connection_id` IS NOT NULL;--> statement-breakpoint

INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('mcp', s.`scope_id`, s.`id`, 'auth:oauth2:client-id'),
	s.`scope_id`,
	'mcp',
	s.`id`,
	s.`scope_id`,
	'auth:oauth2:client-id',
	'secret',
	NULL,
	s.`auth_client_id_secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `mcp_source` s
WHERE s.`auth_kind` = 'oauth2'
  AND s.`auth_client_id_secret_id` IS NOT NULL;--> statement-breakpoint

INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('mcp', s.`scope_id`, s.`id`, 'auth:oauth2:client-secret'),
	s.`scope_id`,
	'mcp',
	s.`id`,
	s.`scope_id`,
	'auth:oauth2:client-secret',
	'secret',
	NULL,
	s.`auth_client_secret_secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `mcp_source` s
WHERE s.`auth_kind` = 'oauth2'
  AND s.`auth_client_secret_secret_id` IS NOT NULL;--> statement-breakpoint

DROP INDEX `mcp_source_auth_secret_id_idx`;--> statement-breakpoint
DROP INDEX `mcp_source_auth_connection_id_idx`;--> statement-breakpoint
DROP INDEX `mcp_source_auth_client_id_secret_id_idx`;--> statement-breakpoint
DROP INDEX `mcp_source_auth_client_secret_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `mcp_source` DROP COLUMN `auth_secret_id`;--> statement-breakpoint
ALTER TABLE `mcp_source` DROP COLUMN `auth_secret_prefix`;--> statement-breakpoint
ALTER TABLE `mcp_source` DROP COLUMN `auth_connection_id`;--> statement-breakpoint
ALTER TABLE `mcp_source` DROP COLUMN `auth_client_id_secret_id`;--> statement-breakpoint
ALTER TABLE `mcp_source` DROP COLUMN `auth_client_secret_secret_id`;--> statement-breakpoint

ALTER TABLE `mcp_source_header` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `mcp_source_header` ADD `prefix` text;--> statement-breakpoint

CREATE TEMP TABLE `__mcp_header_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__mcp_header_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	h.`scope_id`,
	h.`source_id`,
	'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`name`), 'default') AS `slot_key`
FROM `mcp_source_header` h
WHERE h.`kind` = 'secret'
  AND h.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__mcp_header_slot_preflight`;--> statement-breakpoint

WITH header_rows AS (
	SELECT
		h.`scope_id`,
		h.`source_id`,
		h.`name`,
		'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`name`), 'default') AS `slot_key`,
		h.`secret_id`,
		h.`secret_prefix`
	FROM `mcp_source_header` h
	WHERE h.`kind` = 'secret'
	  AND h.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('mcp', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'mcp',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM header_rows r;--> statement-breakpoint

UPDATE `mcp_source_header`
SET
	`kind` = 'binding',
	`slot_key` = 'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`text_value` = NULL
WHERE `kind` = 'secret'
  AND `secret_id` IS NOT NULL;--> statement-breakpoint

DROP INDEX `mcp_source_header_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `mcp_source_header` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `mcp_source_header` DROP COLUMN `secret_prefix`;--> statement-breakpoint

ALTER TABLE `mcp_source_query_param` ADD `slot_key` text;--> statement-breakpoint
ALTER TABLE `mcp_source_query_param` ADD `prefix` text;--> statement-breakpoint

CREATE TEMP TABLE `__mcp_query_param_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__mcp_query_param_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	q.`scope_id`,
	q.`source_id`,
	'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = q.`name`), 'default') AS `slot_key`
FROM `mcp_source_query_param` q
WHERE q.`kind` = 'secret'
  AND q.`secret_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `__mcp_query_param_slot_preflight`;--> statement-breakpoint

WITH query_param_rows AS (
	SELECT
		q.`scope_id`,
		q.`source_id`,
		q.`name`,
		'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = q.`name`), 'default') AS `slot_key`,
		q.`secret_id`,
		q.`secret_prefix`
	FROM `mcp_source_query_param` q
	WHERE q.`kind` = 'secret'
	  AND q.`secret_id` IS NOT NULL
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('mcp', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'mcp',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM query_param_rows r;--> statement-breakpoint

UPDATE `mcp_source_query_param`
SET
	`kind` = 'binding',
	`slot_key` = 'query_param:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = `name`), 'default'),
	`prefix` = `secret_prefix`,
	`text_value` = NULL
WHERE `kind` = 'secret'
  AND `secret_id` IS NOT NULL;--> statement-breakpoint

DROP INDEX `mcp_source_query_param_secret_id_idx`;--> statement-breakpoint
ALTER TABLE `mcp_source_query_param` DROP COLUMN `secret_id`;--> statement-breakpoint
ALTER TABLE `mcp_source_query_param` DROP COLUMN `secret_prefix`;--> statement-breakpoint

-- 0013_normalize_oauth_connections.sql
-- Normalize pre-unified OAuth connection rows to the canonical core
-- provider/provider_state shape. Runtime refresh only reads provider='oauth2'
-- and provider_state.kind after this one-shot data migration.

UPDATE `connection`
SET
  `provider` = 'oauth2',
  `provider_state` = json_object(
    'kind', CASE json_extract(`provider_state`, '$.flow')
      WHEN 'authorizationCode' THEN 'authorization-code'
      ELSE 'client-credentials'
    END,
    'tokenEndpoint', json_extract(`provider_state`, '$.tokenUrl'),
    'issuerUrl', NULL,
    'clientIdSecretId', json_extract(`provider_state`, '$.clientIdSecretId'),
    'clientSecretSecretId', CASE json_extract(`provider_state`, '$.flow')
      WHEN 'clientCredentials' THEN coalesce(json_extract(`provider_state`, '$.clientSecretSecretId'), '')
      ELSE json_extract(`provider_state`, '$.clientSecretSecretId')
    END,
    'clientAuth', 'body',
    'scopes', coalesce(json_extract(`provider_state`, '$.scopes'), json('[]')),
    'scope', `scope`
  ),
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `provider` = 'openapi:oauth2'
  AND json_extract(`provider_state`, '$.flow') IN ('authorizationCode', 'clientCredentials');--> statement-breakpoint

UPDATE `connection`
SET
  `provider` = 'oauth2',
  `provider_state` = json_object(
    'kind', 'dynamic-dcr',
    'tokenEndpoint', coalesce(
      json_extract(`provider_state`, '$.tokenEndpoint'),
      json_extract(`provider_state`, '$.authorizationServerMetadata.token_endpoint'),
      ''
    ),
    'issuerUrl', json_extract(`provider_state`, '$.authorizationServerMetadata.issuer'),
    'authorizationServerUrl', json_extract(`provider_state`, '$.authorizationServerUrl'),
    'authorizationServerMetadataUrl', json_extract(`provider_state`, '$.authorizationServerMetadataUrl'),
    'idTokenSigningAlgValuesSupported', coalesce(
      json_extract(`provider_state`, '$.authorizationServerMetadata.id_token_signing_alg_values_supported'),
      json('[]')
    ),
    'clientId', coalesce(json_extract(`provider_state`, '$.clientInformation.client_id'), ''),
    'clientSecretSecretId', NULL,
    'clientAuth', CASE json_extract(`provider_state`, '$.clientInformation.token_endpoint_auth_method')
      WHEN 'client_secret_basic' THEN 'basic'
      ELSE 'body'
    END,
    'scopes', json('[]'),
    'scope', `scope`,
    'resource', json_extract(`provider_state`, '$.endpoint')
  ),
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `provider` = 'mcp:oauth2';--> statement-breakpoint

UPDATE `connection`
SET
  `provider` = 'oauth2',
  `provider_state` = json_object(
    'kind', 'authorization-code',
    'tokenEndpoint', 'https://oauth2.googleapis.com/token',
    'issuerUrl', 'https://accounts.google.com',
    'clientIdSecretId', json_extract(`provider_state`, '$.clientIdSecretId'),
    'clientSecretSecretId', json_extract(`provider_state`, '$.clientSecretSecretId'),
    'clientAuth', 'body',
    'scopes', coalesce(json_extract(`provider_state`, '$.scopes'), json('[]')),
    'scope', `scope`
  ),
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `provider` IN ('google-discovery:google', 'google-discovery:oauth2');--> statement-breakpoint

-- 0014_openapi_header_rows.sql
-- Move OpenAPI request headers out of openapi_source.headers JSON and into
-- the same child-row slot model used by query params and spec-fetch
-- credentials. Runtime code reads only openapi_source_header after this.

CREATE TABLE `openapi_source_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`slot_key` text,
	`prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);--> statement-breakpoint
CREATE INDEX `openapi_source_header_scope_id_idx` ON `openapi_source_header` (`scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_header_source_id_idx` ON `openapi_source_header` (`source_id`);--> statement-breakpoint

CREATE TEMP TABLE `__openapi_header_row_slot_preflight` (
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`slot_key` text NOT NULL,
	PRIMARY KEY (`scope_id`, `source_id`, `slot_key`)
);--> statement-breakpoint

INSERT INTO `__openapi_header_row_slot_preflight` (`scope_id`, `source_id`, `slot_key`)
SELECT
	s.`scope_id`,
	s.`id`,
	'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default') AS `slot_key`
FROM `openapi_source` s, json_each(s.`headers`) h
WHERE s.`headers` IS NOT NULL
  AND h.`type` = 'object'
  AND json_extract(h.`value`, '$.secretId') IS NOT NULL
  AND COALESCE(json_extract(h.`value`, '$.kind'), 'secret') = 'secret';--> statement-breakpoint

DROP TABLE `__openapi_header_row_slot_preflight`;--> statement-breakpoint

WITH header_rows AS (
	SELECT
		s.`scope_id`,
		s.`id` AS `source_id`,
		h.`key` AS `name`,
		'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default') AS `slot_key`,
		json_extract(h.`value`, '$.secretId') AS `secret_id`
	FROM `openapi_source` s, json_each(s.`headers`) h
	WHERE s.`headers` IS NOT NULL
	  AND h.`type` = 'object'
	  AND json_extract(h.`value`, '$.secretId') IS NOT NULL
	  AND COALESCE(json_extract(h.`value`, '$.kind'), 'secret') = 'secret'
)
INSERT OR REPLACE INTO `credential_binding` (
	`id`, `scope_id`, `plugin_id`, `source_id`, `source_scope_id`, `slot_key`,
	`kind`, `text_value`, `secret_id`, `connection_id`, `created_at`, `updated_at`
)
SELECT
	json_array('openapi', r.`scope_id`, r.`source_id`, r.`slot_key`),
	r.`scope_id`,
	'openapi',
	r.`source_id`,
	r.`scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM header_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM `credential_binding` b
	WHERE b.`scope_id` = r.`scope_id`
	  AND b.`plugin_id` = 'openapi'
	  AND b.`source_id` = r.`source_id`
	  AND b.`source_scope_id` = r.`scope_id`
	  AND b.`slot_key` = r.`slot_key`
);--> statement-breakpoint

INSERT OR REPLACE INTO `openapi_source_header` (
	`id`, `scope_id`, `source_id`, `name`, `kind`, `text_value`, `slot_key`, `prefix`
)
SELECT
	json_array(s.`id`, h.`key`),
	s.`scope_id`,
	s.`id`,
	h.`key`,
	CASE
		WHEN h.`type` = 'text' THEN 'text'
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.kind') = 'text' THEN 'text'
		ELSE 'binding'
	END,
	CASE
		WHEN h.`type` = 'text' THEN h.`value`
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.kind') = 'text'
			THEN json_extract(h.`value`, '$.text')
		ELSE NULL
	END,
	CASE
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.kind') = 'binding'
			THEN json_extract(h.`value`, '$.slot')
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.secretId') IS NOT NULL
			THEN 'header:' || COALESCE((SELECT `slug` FROM `__slug_norm` WHERE `raw` = h.`key`), 'default')
		ELSE NULL
	END,
	CASE
		WHEN h.`type` = 'object'
			THEN COALESCE(json_extract(h.`value`, '$.prefix'), json_extract(h.`value`, '$.secretPrefix'))
		ELSE NULL
	END
FROM `openapi_source` s, json_each(s.`headers`) h
WHERE s.`headers` IS NOT NULL
  AND (
	h.`type` = 'text'
	OR (
		h.`type` = 'object'
		AND (
			json_extract(h.`value`, '$.kind') IN ('binding', 'text')
			OR json_extract(h.`value`, '$.secretId') IS NOT NULL
		)
	)
);--> statement-breakpoint

ALTER TABLE `openapi_source` DROP COLUMN `headers`;

--> statement-breakpoint
DROP TABLE `__slug_norm`;
