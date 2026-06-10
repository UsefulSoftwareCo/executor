-- Repair OpenAPI OAuth residue from the scoped-credential cutover.

UPDATE `connection`
SET `provider` = 'oauth2',
    `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `provider` = 'openapi:oauth2'
  AND json_extract(`provider_state`, '$.kind') IS NOT NULL;--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b.`scope_id`,
		b.`id` AS `binding_id`,
		b.`plugin_id`,
		b.`source_id`,
		b.`source_scope_id`,
		json_extract(s.`oauth2`, '$.clientIdSlot') AS `slot_key`,
		json_extract(c.`provider_state`, '$.clientIdSecretId') AS `secret_id`,
		b.`created_at`
	FROM `credential_binding` b
	JOIN `openapi_source` s
	  ON s.`id` = b.`source_id`
	 AND s.`scope_id` = b.`source_scope_id`
	JOIN `connection` c
	  ON c.`id` = b.`connection_id`
	 AND c.`scope_id` = b.`scope_id`
	WHERE b.`plugin_id` = 'openapi'
	  AND b.`kind` = 'connection'
	  AND s.`oauth2` IS NOT NULL
	  AND c.`provider` = 'oauth2'
	  AND json_extract(c.`provider_state`, '$.clientIdSecretId') IS NOT NULL
	  AND coalesce(json_extract(c.`provider_state`, '$.clientIdSecretId'), '') <> ''
)
UPDATE `credential_binding`
SET
	`secret_id` = (
		SELECT r.`secret_id`
		FROM oauth_connections r
		WHERE r.`scope_id` = `credential_binding`.`scope_id`
		  AND r.`plugin_id` = `credential_binding`.`plugin_id`
		  AND r.`source_id` = `credential_binding`.`source_id`
		  AND r.`source_scope_id` = `credential_binding`.`source_scope_id`
		  AND r.`slot_key` = `credential_binding`.`slot_key`
		LIMIT 1
	),
	`text_value` = NULL,
	`connection_id` = NULL,
	`updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `kind` = 'secret'
  AND EXISTS (
		SELECT 1
		FROM oauth_connections r
		WHERE r.`scope_id` = `credential_binding`.`scope_id`
		  AND r.`plugin_id` = `credential_binding`.`plugin_id`
		  AND r.`source_id` = `credential_binding`.`source_id`
		  AND r.`source_scope_id` = `credential_binding`.`source_scope_id`
		  AND r.`slot_key` = `credential_binding`.`slot_key`
	);--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b.`scope_id`,
		b.`id` AS `binding_id`,
		b.`plugin_id`,
		b.`source_id`,
		b.`source_scope_id`,
		json_extract(s.`oauth2`, '$.clientIdSlot') AS `slot_key`,
		json_extract(c.`provider_state`, '$.clientIdSecretId') AS `secret_id`,
		b.`created_at`
	FROM `credential_binding` b
	JOIN `openapi_source` s
	  ON s.`id` = b.`source_id`
	 AND s.`scope_id` = b.`source_scope_id`
	JOIN `connection` c
	  ON c.`id` = b.`connection_id`
	 AND c.`scope_id` = b.`scope_id`
	WHERE b.`plugin_id` = 'openapi'
	  AND b.`kind` = 'connection'
	  AND s.`oauth2` IS NOT NULL
	  AND c.`provider` = 'oauth2'
	  AND json_extract(c.`provider_state`, '$.clientIdSecretId') IS NOT NULL
	  AND coalesce(json_extract(c.`provider_state`, '$.clientIdSecretId'), '') <> ''
)
INSERT INTO `credential_binding` (
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
	json_array('oconn-openapi-oauth-client', r.`binding_id`, r.`scope_id`, r.`slot_key`),
	r.`scope_id`,
	r.`plugin_id`,
	r.`source_id`,
	r.`source_scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	r.`created_at`,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM oauth_connections r
WHERE r.`slot_key` IS NOT NULL
  AND NOT EXISTS (
		SELECT 1
		FROM `credential_binding` existing
		WHERE existing.`scope_id` = r.`scope_id`
		  AND existing.`plugin_id` = r.`plugin_id`
		  AND existing.`source_id` = r.`source_id`
		  AND existing.`source_scope_id` = r.`source_scope_id`
		  AND existing.`slot_key` = r.`slot_key`
	)
ON CONFLICT(`scope_id`, `id`) DO UPDATE SET
	`plugin_id` = excluded.`plugin_id`,
	`source_id` = excluded.`source_id`,
	`source_scope_id` = excluded.`source_scope_id`,
	`slot_key` = excluded.`slot_key`,
	`kind` = excluded.`kind`,
	`text_value` = excluded.`text_value`,
	`secret_id` = excluded.`secret_id`,
	`connection_id` = excluded.`connection_id`,
	`updated_at` = excluded.`updated_at`;--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b.`scope_id`,
		b.`id` AS `binding_id`,
		b.`plugin_id`,
		b.`source_id`,
		b.`source_scope_id`,
		json_extract(s.`oauth2`, '$.clientSecretSlot') AS `slot_key`,
		json_extract(c.`provider_state`, '$.clientSecretSecretId') AS `secret_id`,
		b.`created_at`
	FROM `credential_binding` b
	JOIN `openapi_source` s
	  ON s.`id` = b.`source_id`
	 AND s.`scope_id` = b.`source_scope_id`
	JOIN `connection` c
	  ON c.`id` = b.`connection_id`
	 AND c.`scope_id` = b.`scope_id`
	WHERE b.`plugin_id` = 'openapi'
	  AND b.`kind` = 'connection'
	  AND s.`oauth2` IS NOT NULL
	  AND c.`provider` = 'oauth2'
	  AND json_extract(c.`provider_state`, '$.clientSecretSecretId') IS NOT NULL
	  AND coalesce(json_extract(c.`provider_state`, '$.clientSecretSecretId'), '') <> ''
)
UPDATE `credential_binding`
SET
	`secret_id` = (
		SELECT r.`secret_id`
		FROM oauth_connections r
		WHERE r.`scope_id` = `credential_binding`.`scope_id`
		  AND r.`plugin_id` = `credential_binding`.`plugin_id`
		  AND r.`source_id` = `credential_binding`.`source_id`
		  AND r.`source_scope_id` = `credential_binding`.`source_scope_id`
		  AND r.`slot_key` = `credential_binding`.`slot_key`
		LIMIT 1
	),
	`text_value` = NULL,
	`connection_id` = NULL,
	`updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `kind` = 'secret'
  AND EXISTS (
		SELECT 1
		FROM oauth_connections r
		WHERE r.`scope_id` = `credential_binding`.`scope_id`
		  AND r.`plugin_id` = `credential_binding`.`plugin_id`
		  AND r.`source_id` = `credential_binding`.`source_id`
		  AND r.`source_scope_id` = `credential_binding`.`source_scope_id`
		  AND r.`slot_key` = `credential_binding`.`slot_key`
	);--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b.`scope_id`,
		b.`id` AS `binding_id`,
		b.`plugin_id`,
		b.`source_id`,
		b.`source_scope_id`,
		json_extract(s.`oauth2`, '$.clientSecretSlot') AS `slot_key`,
		json_extract(c.`provider_state`, '$.clientSecretSecretId') AS `secret_id`,
		b.`created_at`
	FROM `credential_binding` b
	JOIN `openapi_source` s
	  ON s.`id` = b.`source_id`
	 AND s.`scope_id` = b.`source_scope_id`
	JOIN `connection` c
	  ON c.`id` = b.`connection_id`
	 AND c.`scope_id` = b.`scope_id`
	WHERE b.`plugin_id` = 'openapi'
	  AND b.`kind` = 'connection'
	  AND s.`oauth2` IS NOT NULL
	  AND c.`provider` = 'oauth2'
	  AND json_extract(c.`provider_state`, '$.clientSecretSecretId') IS NOT NULL
	  AND coalesce(json_extract(c.`provider_state`, '$.clientSecretSecretId'), '') <> ''
)
INSERT INTO `credential_binding` (
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
	json_array('oconn-openapi-oauth-secret', r.`binding_id`, r.`scope_id`, r.`slot_key`),
	r.`scope_id`,
	r.`plugin_id`,
	r.`source_id`,
	r.`source_scope_id`,
	r.`slot_key`,
	'secret',
	NULL,
	r.`secret_id`,
	NULL,
	r.`created_at`,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM oauth_connections r
WHERE r.`slot_key` IS NOT NULL
  AND NOT EXISTS (
		SELECT 1
		FROM `credential_binding` existing
		WHERE existing.`scope_id` = r.`scope_id`
		  AND existing.`plugin_id` = r.`plugin_id`
		  AND existing.`source_id` = r.`source_id`
		  AND existing.`source_scope_id` = r.`source_scope_id`
		  AND existing.`slot_key` = r.`slot_key`
	)
ON CONFLICT(`scope_id`, `id`) DO UPDATE SET
	`plugin_id` = excluded.`plugin_id`,
	`source_id` = excluded.`source_id`,
	`source_scope_id` = excluded.`source_scope_id`,
	`slot_key` = excluded.`slot_key`,
	`kind` = excluded.`kind`,
	`text_value` = excluded.`text_value`,
	`secret_id` = excluded.`secret_id`,
	`connection_id` = excluded.`connection_id`,
	`updated_at` = excluded.`updated_at`;
