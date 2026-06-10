-- Normalize all plugin secret/connection refs out of JSON columns
-- into proper relational shape: graphql, openapi, mcp,
-- google-discovery. Each block is a self-contained backfill of one
-- plugin's tables; collected here so the schema lands in one
-- migration step instead of four sequential ones.
--
-- Old shape (per plugin):
--   {plugin}_source.{auth, headers, query_params, ...}: json blobs
--   openapi_source_binding.value:                       json union
--   {plugin}_source.config.{auth, headers, queryParams}: nested json
--
-- New shape (per plugin):
--   Flat auth_* columns on the parent (auth_kind enum + per-kind id
--   columns, all indexed where they hold refs).
--   Child tables for SecretBackedMap entries: one row per (source,
--   header_name) keyed by JSON tuple [source_id,name] so user keys
--   with separators don't collide. `secret_id` indexed for the
--   usagesForSecret query.

-- ============================================================
-- graphql
-- ============================================================

-- Normalize graphql plugin: move secret/connection refs out of JSON
-- columns into proper relational shape so usagesForSecret /
-- usagesForConnection are one indexed SELECT instead of a JSON scan.
--
-- Old shape:
--   graphql_source.headers      json   Record<name, string | {secretId,prefix?}>
--   graphql_source.query_params json   Record<name, string | {secretId,prefix?}>
--   graphql_source.auth         json   {kind:"none"} | {kind:"oauth2", connectionId}
--
-- New shape:
--   graphql_source.auth_kind          enum("none","oauth2") NOT NULL
--   graphql_source.auth_connection_id text indexed nullable
--   graphql_source_header(scope_id, id, source_id, name, kind, text_value, secret_id, secret_prefix)
--   graphql_source_query_param(scope_id, id, source_id, name, kind, text_value, secret_id, secret_prefix)

CREATE TABLE `graphql_source_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_source_header_scope_id_idx` ON `graphql_source_header` (`scope_id`);--> statement-breakpoint
CREATE INDEX `graphql_source_header_source_id_idx` ON `graphql_source_header` (`source_id`);--> statement-breakpoint
CREATE INDEX `graphql_source_header_secret_id_idx` ON `graphql_source_header` (`secret_id`);--> statement-breakpoint

CREATE TABLE `graphql_source_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_source_query_param_scope_id_idx` ON `graphql_source_query_param` (`scope_id`);--> statement-breakpoint
CREATE INDEX `graphql_source_query_param_source_id_idx` ON `graphql_source_query_param` (`source_id`);--> statement-breakpoint
CREATE INDEX `graphql_source_query_param_secret_id_idx` ON `graphql_source_query_param` (`secret_id`);--> statement-breakpoint

-- New auth columns. `auth_kind` defaults to "none" so existing rows that
-- predate this migration are valid even if the json was null.
ALTER TABLE `graphql_source` ADD `auth_kind` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `graphql_source` ADD `auth_connection_id` text;--> statement-breakpoint
CREATE INDEX `graphql_source_auth_connection_id_idx` ON `graphql_source` (`auth_connection_id`);--> statement-breakpoint

-- Backfill auth from the JSON column. json_extract returns NULL for
-- missing paths, so a row with auth=NULL or kind="none" leaves
-- auth_connection_id NULL and auth_kind defaulted to "none".
UPDATE `graphql_source`
SET
	`auth_kind` = COALESCE(json_extract(`auth`, '$.kind'), 'none'),
	`auth_connection_id` = json_extract(`auth`, '$.connectionId')
WHERE `auth` IS NOT NULL;--> statement-breakpoint

-- Backfill headers. For each (source, header_name) pair: if the value
-- is a json object with .secretId, write a kind=secret row; otherwise
-- write a kind=text row with the literal string. json_each iterates
-- the keys of the headers object.
INSERT OR IGNORE INTO `graphql_source_header`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, h.`key`),
	s.`id`,
	h.`key`,
	CASE
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN h.`type` = 'object' THEN NULL ELSE h.`value` END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.prefix') ELSE NULL END
FROM `graphql_source` s, json_each(s.`headers`) h
WHERE s.`headers` IS NOT NULL;--> statement-breakpoint

-- Same for query_params.
INSERT OR IGNORE INTO `graphql_source_query_param`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, q.`key`),
	s.`id`,
	q.`key`,
	CASE
		WHEN q.`type` = 'object' AND json_extract(q.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN q.`type` = 'object' THEN NULL ELSE q.`value` END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.prefix') ELSE NULL END
FROM `graphql_source` s, json_each(s.`query_params`) q
WHERE s.`query_params` IS NOT NULL;--> statement-breakpoint

-- Drop the old JSON columns. SQLite ≥ 3.35 supports ALTER TABLE DROP
-- COLUMN directly; bun's bundled SQLite is well past that.
ALTER TABLE `graphql_source` DROP COLUMN `headers`;--> statement-breakpoint
ALTER TABLE `graphql_source` DROP COLUMN `query_params`;--> statement-breakpoint
ALTER TABLE `graphql_source` DROP COLUMN `auth`;

--> statement-breakpoint

-- ============================================================
-- openapi
-- ============================================================

-- Normalize openapi plugin: move every direct secret/connection ref out
-- of JSON columns into proper relational shape.
--
-- Old shape:
--   openapi_source.query_params      json   Record<name, string | {secretId,prefix?}>
--   openapi_source.invocation_config json   { specFetchCredentials?: { headers, queryParams } }
--   openapi_source_binding.value     json   discriminated union
--                                           {kind:"secret",secretId} | {kind:"connection",connectionId} | {kind:"text",text}
--
-- New shape:
--   openapi_source_binding gains kind/secret_id/connection_id/text_value columns.
--   `headers` / `oauth2` on openapi_source stay JSON because they hold
--   slot names, not direct refs — the actual credentials reach those
--   slots through openapi_source_binding rows, which ARE normalized.
--   openapi_source_query_param: child table, secret-backed entries.
--   openapi_source_spec_fetch_header / spec_fetch_query_param: child
--   tables for the equivalent maps inside specFetchCredentials.

CREATE TABLE `openapi_source_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_query_param_scope_id_idx` ON `openapi_source_query_param` (`scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_query_param_source_id_idx` ON `openapi_source_query_param` (`source_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_query_param_secret_id_idx` ON `openapi_source_query_param` (`secret_id`);--> statement-breakpoint

CREATE TABLE `openapi_source_spec_fetch_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_header_scope_id_idx` ON `openapi_source_spec_fetch_header` (`scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_header_source_id_idx` ON `openapi_source_spec_fetch_header` (`source_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_header_secret_id_idx` ON `openapi_source_spec_fetch_header` (`secret_id`);--> statement-breakpoint

CREATE TABLE `openapi_source_spec_fetch_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_query_param_scope_id_idx` ON `openapi_source_spec_fetch_query_param` (`scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_query_param_source_id_idx` ON `openapi_source_spec_fetch_query_param` (`source_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_spec_fetch_query_param_secret_id_idx` ON `openapi_source_spec_fetch_query_param` (`secret_id`);--> statement-breakpoint

-- New columns on openapi_source_binding to flatten the value json.
-- `kind` defaults to 'text' so the ALTER works on existing rows; the
-- backfill below stamps the real value.
ALTER TABLE `openapi_source_binding` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `openapi_source_binding` ADD `secret_id` text;--> statement-breakpoint
ALTER TABLE `openapi_source_binding` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `openapi_source_binding` ADD `text_value` text;--> statement-breakpoint
CREATE INDEX `openapi_source_binding_secret_id_idx` ON `openapi_source_binding` (`secret_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_connection_id_idx` ON `openapi_source_binding` (`connection_id`);--> statement-breakpoint

-- Backfill the binding columns from the legacy `value` JSON. We pull
-- $.kind into `kind` directly; for each kind the matching id field
-- (`secretId` / `connectionId` / `text`) gets copied into the matching
-- column. Rows whose value JSON is malformed or missing $.kind fall
-- through to kind='text' with a NULL text_value — same as a missing
-- text binding, the source will surface "binding not configured" at
-- invoke time rather than crashing the migration.
UPDATE `openapi_source_binding`
SET
	`kind` = COALESCE(json_extract(`value`, '$.kind'), 'text'),
	`secret_id` = CASE WHEN json_extract(`value`, '$.kind') = 'secret' THEN json_extract(`value`, '$.secretId') ELSE NULL END,
	`connection_id` = CASE WHEN json_extract(`value`, '$.kind') = 'connection' THEN json_extract(`value`, '$.connectionId') ELSE NULL END,
	`text_value` = CASE WHEN json_extract(`value`, '$.kind') = 'text' THEN json_extract(`value`, '$.text') ELSE NULL END
WHERE `value` IS NOT NULL;--> statement-breakpoint

-- Backfill openapi_source_query_param from openapi_source.query_params.
-- json_each iterates the keys of the query_params object. For each
-- entry: if the value is an object with .secretId, write a kind=secret
-- row; otherwise write a kind=text row with the literal string.
INSERT OR IGNORE INTO `openapi_source_query_param`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, q.`key`),
	s.`id`,
	q.`key`,
	CASE
		WHEN q.`type` = 'object' AND json_extract(q.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN q.`type` = 'object' THEN NULL ELSE q.`value` END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.prefix') ELSE NULL END
FROM `openapi_source` s, json_each(s.`query_params`) q
WHERE s.`query_params` IS NOT NULL;--> statement-breakpoint

-- Backfill openapi_source_spec_fetch_header from
-- openapi_source.invocation_config.specFetchCredentials.headers. Same
-- shape as query_params; the JSON path is one level deeper.
INSERT OR IGNORE INTO `openapi_source_spec_fetch_header`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, h.`key`),
	s.`id`,
	h.`key`,
	CASE
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN h.`type` = 'object' THEN NULL ELSE h.`value` END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.prefix') ELSE NULL END
FROM `openapi_source` s, json_each(json_extract(s.`invocation_config`, '$.specFetchCredentials.headers')) h
WHERE json_extract(s.`invocation_config`, '$.specFetchCredentials.headers') IS NOT NULL;--> statement-breakpoint

INSERT OR IGNORE INTO `openapi_source_spec_fetch_query_param`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, q.`key`),
	s.`id`,
	q.`key`,
	CASE
		WHEN q.`type` = 'object' AND json_extract(q.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN q.`type` = 'object' THEN NULL ELSE q.`value` END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.prefix') ELSE NULL END
FROM `openapi_source` s, json_each(json_extract(s.`invocation_config`, '$.specFetchCredentials.queryParams')) q
WHERE json_extract(s.`invocation_config`, '$.specFetchCredentials.queryParams') IS NOT NULL;--> statement-breakpoint

-- Preserve any legacy OAuth payload from invocation_config.oauth2 into
-- the still-existing oauth2 column before we drop invocation_config.
-- migrateLegacyConnections runs after drizzle migrations and reads
-- oauth2 to detect the legacy shape; without this, rows that only had
-- their OAuth payload under invocation_config.oauth2 would lose it.
UPDATE `openapi_source`
SET `oauth2` = json_extract(`invocation_config`, '$.oauth2')
WHERE `oauth2` IS NULL
  AND json_extract(`invocation_config`, '$.oauth2') IS NOT NULL;--> statement-breakpoint

-- Drop the legacy JSON columns now that everything is normalized.
ALTER TABLE `openapi_source_binding` DROP COLUMN `value`;--> statement-breakpoint
ALTER TABLE `openapi_source` DROP COLUMN `query_params`;--> statement-breakpoint
ALTER TABLE `openapi_source` DROP COLUMN `invocation_config`;

--> statement-breakpoint

-- ============================================================
-- mcp
-- ============================================================

-- Normalize mcp plugin: lift the McpConnectionAuth secret/connection
-- refs and the SecretBackedMap headers/query_params out of
-- mcp_source.config JSON into proper columns / child tables.
--
-- Old shape:
--   mcp_source.config (json) — McpStoredSourceData discriminated union
--     remote: { transport, endpoint, remoteTransport?, queryParams?,
--               headers?, auth: McpConnectionAuth }
--     stdio:  { transport, command, args?, env?, cwd? }
--
-- New shape:
--   mcp_source gains: auth_kind enum, auth_header_name, auth_secret_id,
--     auth_secret_prefix, auth_connection_id, auth_client_id_secret_id,
--     auth_client_secret_secret_id. The remaining structural fields
--     stay in `config` as JSON because they're plugin-private and
--     vary by transport.
--   mcp_source_header / mcp_source_query_param: child tables for
--     remote sources' SecretBackedMap entries (same column shape as
--     graphql_source_header / openapi_source_query_param).

CREATE TABLE `mcp_source_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_source_header_scope_id_idx` ON `mcp_source_header` (`scope_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_header_source_id_idx` ON `mcp_source_header` (`source_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_header_secret_id_idx` ON `mcp_source_header` (`secret_id`);--> statement-breakpoint

CREATE TABLE `mcp_source_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_source_query_param_scope_id_idx` ON `mcp_source_query_param` (`scope_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_query_param_source_id_idx` ON `mcp_source_query_param` (`source_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_query_param_secret_id_idx` ON `mcp_source_query_param` (`secret_id`);--> statement-breakpoint

-- New auth columns. `auth_kind` defaults to "none" so the ALTER passes
-- on existing rows; the backfill below stamps the real value.
ALTER TABLE `mcp_source` ADD `auth_kind` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_header_name` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_secret_id` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_secret_prefix` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_connection_id` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_client_id_secret_id` text;--> statement-breakpoint
ALTER TABLE `mcp_source` ADD `auth_client_secret_secret_id` text;--> statement-breakpoint
CREATE INDEX `mcp_source_auth_secret_id_idx` ON `mcp_source` (`auth_secret_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_auth_connection_id_idx` ON `mcp_source` (`auth_connection_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_auth_client_id_secret_id_idx` ON `mcp_source` (`auth_client_id_secret_id`);--> statement-breakpoint
CREATE INDEX `mcp_source_auth_client_secret_secret_id_idx` ON `mcp_source` (`auth_client_secret_secret_id`);--> statement-breakpoint

-- Backfill auth columns from config.auth — but only for rows whose
-- config.auth matches the *current* shape:
--   - kind=none           (no extra fields)
--   - kind=header         (secretId present)
--   - kind=oauth2         (connectionId present)
-- Truly-legacy rows (inline OAuth shape with accessTokenSecretId etc.)
-- are left untouched here so the post-migrate `migrateLegacyConnections`
-- script can convert them to a Connection and write the resulting
-- pointer to these columns. Setting auth_kind explicitly to NULL/none
-- on those rows would lose the legacy payload before it gets converted.
UPDATE `mcp_source`
SET
	`auth_kind` = json_extract(`config`, '$.auth.kind'),
	`auth_header_name` = json_extract(`config`, '$.auth.headerName'),
	`auth_secret_id` = json_extract(`config`, '$.auth.secretId'),
	`auth_secret_prefix` = json_extract(`config`, '$.auth.prefix'),
	`auth_connection_id` = json_extract(`config`, '$.auth.connectionId'),
	`auth_client_id_secret_id` = json_extract(`config`, '$.auth.clientIdSecretId'),
	`auth_client_secret_secret_id` = json_extract(`config`, '$.auth.clientSecretSecretId')
WHERE `config` IS NOT NULL
  AND (
    -- kind=none and "no auth at all" both leave auth_kind defaulted to
    -- 'none' (the column DEFAULT), so we only UPDATE rows that have a
    -- non-trivial current-shape auth payload to extract.
    (
      json_extract(`config`, '$.auth.kind') = 'header'
      AND json_extract(`config`, '$.auth.secretId') IS NOT NULL
    )
    OR (
      json_extract(`config`, '$.auth.kind') = 'oauth2'
      AND json_extract(`config`, '$.auth.connectionId') IS NOT NULL
    )
  );--> statement-breakpoint

-- Backfill mcp_source_header from config.headers. Remote sources only;
-- stdio's config has no `.headers` key so json_each returns nothing.
INSERT OR IGNORE INTO `mcp_source_header`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, h.`key`),
	s.`id`,
	h.`key`,
	CASE
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN h.`type` = 'object' THEN NULL ELSE h.`value` END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.prefix') ELSE NULL END
FROM `mcp_source` s, json_each(json_extract(s.`config`, '$.headers')) h
WHERE json_extract(s.`config`, '$.headers') IS NOT NULL;--> statement-breakpoint

INSERT OR IGNORE INTO `mcp_source_query_param`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, q.`key`),
	s.`id`,
	q.`key`,
	CASE
		WHEN q.`type` = 'object' AND json_extract(q.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN q.`type` = 'object' THEN NULL ELSE q.`value` END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.prefix') ELSE NULL END
FROM `mcp_source` s, json_each(json_extract(s.`config`, '$.queryParams')) q
WHERE json_extract(s.`config`, '$.queryParams') IS NOT NULL;--> statement-breakpoint

-- Strip the now-extracted fields from the legacy config JSON. Skip
-- rows whose config.auth still holds a legacy inline-OAuth payload —
-- migrateLegacyConnections needs to read it to mint the matching
-- Connection. headers/queryParams are always safe to strip (already
-- copied to child tables). SQLite's json_remove returns the input
-- unchanged when a path is missing, so stdio rows pass through
-- cleanly.
UPDATE `mcp_source`
SET `config` = json_remove(`config`, '$.headers', '$.queryParams')
WHERE `config` IS NOT NULL;--> statement-breakpoint

UPDATE `mcp_source`
SET `config` = json_remove(`config`, '$.auth')
WHERE `config` IS NOT NULL
  AND (
    json_extract(`config`, '$.auth.kind') = 'none'
    OR (
      json_extract(`config`, '$.auth.kind') = 'header'
      AND json_extract(`config`, '$.auth.secretId') IS NOT NULL
    )
    OR (
      json_extract(`config`, '$.auth.kind') = 'oauth2'
      AND json_extract(`config`, '$.auth.connectionId') IS NOT NULL
    )
  );

--> statement-breakpoint

-- ============================================================
-- google-discovery
-- ============================================================

-- Normalize google-discovery plugin: lift the GoogleDiscoveryAuth and
-- the credentials.{headers,queryParams} SecretBackedMaps out of
-- google_discovery_source.config JSON.
--
-- Old shape:
--   google_discovery_source.config (json) — GoogleDiscoveryStoredSourceData
--     with `auth: {kind:"none"} | {kind:"oauth2", connectionId, clientId..., clientSecret..., scopes}`
--     and optional `credentials: { headers?, queryParams? }`
--
-- New shape:
--   google_discovery_source gains: auth_kind, auth_connection_id,
--     auth_client_id_secret_id, auth_client_secret_secret_id, auth_scopes.
--   google_discovery_source_credential_header / _query_param: child
--     tables for the SecretBackedMap entries.

CREATE TABLE `google_discovery_source_credential_header` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_header_scope_id_idx` ON `google_discovery_source_credential_header` (`scope_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_header_source_id_idx` ON `google_discovery_source_credential_header` (`source_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_header_secret_id_idx` ON `google_discovery_source_credential_header` (`secret_id`);--> statement-breakpoint

CREATE TABLE `google_discovery_source_credential_query_param` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`text_value` text,
	`secret_id` text,
	`secret_prefix` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_query_param_scope_id_idx` ON `google_discovery_source_credential_query_param` (`scope_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_query_param_source_id_idx` ON `google_discovery_source_credential_query_param` (`source_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_source_credential_query_param_secret_id_idx` ON `google_discovery_source_credential_query_param` (`secret_id`);--> statement-breakpoint

ALTER TABLE `google_discovery_source` ADD `auth_kind` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `google_discovery_source` ADD `auth_connection_id` text;--> statement-breakpoint
ALTER TABLE `google_discovery_source` ADD `auth_client_id_secret_id` text;--> statement-breakpoint
ALTER TABLE `google_discovery_source` ADD `auth_client_secret_secret_id` text;--> statement-breakpoint
ALTER TABLE `google_discovery_source` ADD `auth_scopes` text;--> statement-breakpoint
CREATE INDEX `google_discovery_source_auth_connection_id_idx` ON `google_discovery_source` (`auth_connection_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_source_auth_client_id_secret_id_idx` ON `google_discovery_source` (`auth_client_id_secret_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_source_auth_client_secret_secret_id_idx` ON `google_discovery_source` (`auth_client_secret_secret_id`);--> statement-breakpoint

-- Backfill auth columns from config.auth.
UPDATE `google_discovery_source`
SET
	`auth_kind` = COALESCE(json_extract(`config`, '$.auth.kind'), 'none'),
	`auth_connection_id` = json_extract(`config`, '$.auth.connectionId'),
	`auth_client_id_secret_id` = json_extract(`config`, '$.auth.clientIdSecretId'),
	`auth_client_secret_secret_id` = json_extract(`config`, '$.auth.clientSecretSecretId'),
	`auth_scopes` = json_extract(`config`, '$.auth.scopes')
WHERE `config` IS NOT NULL;--> statement-breakpoint

-- Backfill credential header / query_param child rows.
INSERT OR IGNORE INTO `google_discovery_source_credential_header`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, h.`key`),
	s.`id`,
	h.`key`,
	CASE
		WHEN h.`type` = 'object' AND json_extract(h.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN h.`type` = 'object' THEN NULL ELSE h.`value` END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN h.`type` = 'object' THEN json_extract(h.`value`, '$.prefix') ELSE NULL END
FROM `google_discovery_source` s, json_each(json_extract(s.`config`, '$.credentials.headers')) h
WHERE json_extract(s.`config`, '$.credentials.headers') IS NOT NULL;--> statement-breakpoint

INSERT OR IGNORE INTO `google_discovery_source_credential_query_param`
	(`scope_id`, `id`, `source_id`, `name`, `kind`, `text_value`, `secret_id`, `secret_prefix`)
SELECT
	s.`scope_id`,
	json_array(s.`id`, q.`key`),
	s.`id`,
	q.`key`,
	CASE
		WHEN q.`type` = 'object' AND json_extract(q.`value`, '$.secretId') IS NOT NULL THEN 'secret'
		ELSE 'text'
	END,
	CASE WHEN q.`type` = 'object' THEN NULL ELSE q.`value` END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.secretId') ELSE NULL END,
	CASE WHEN q.`type` = 'object' THEN json_extract(q.`value`, '$.prefix') ELSE NULL END
FROM `google_discovery_source` s, json_each(json_extract(s.`config`, '$.credentials.queryParams')) q
WHERE json_extract(s.`config`, '$.credentials.queryParams') IS NOT NULL;--> statement-breakpoint

-- Strip the extracted fields from the legacy config JSON.
UPDATE `google_discovery_source`
SET `config` = json_remove(`config`, '$.auth', '$.credentials')
WHERE `config` IS NOT NULL;
