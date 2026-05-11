-- Repair OpenAPI OAuth residue from the scoped-credential cutover.
--
-- 0009 only normalized provider='openapi:oauth2' rows whose provider_state
-- still had the old `flow` shape. Some live rows already had canonical
-- `kind` provider_state, so the provider key was skipped. 0012 also collapsed
-- user-scoped OpenAPI OAuth client credential bindings when the backing Secret
-- row lived at the source/org scope. Runtime refresh reads provider_state
-- directly, but edit/refresh UI reads credential_binding rows, so recreate
-- those explicit bindings from the already-canonical Connection rows.

UPDATE "connection"
SET "provider" = 'oauth2',
    "updated_at" = now()
WHERE "provider" = 'openapi:oauth2'
  AND "provider_state" ? 'kind';--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b."scope_id",
		b."id" AS "binding_id",
		b."plugin_id",
		b."source_id",
		b."source_scope_id",
		s."oauth2"->>'clientIdSlot' AS "slot_key",
		c."provider_state"->>'clientIdSecretId' AS "secret_id",
		b."created_at"
	FROM "credential_binding" b
	JOIN "openapi_source" s
	  ON s."id" = b."source_id"
	 AND s."scope_id" = b."source_scope_id"
	JOIN "connection" c
	  ON c."id" = b."connection_id"
	 AND c."scope_id" = b."scope_id"
	WHERE b."plugin_id" = 'openapi'
	  AND b."kind" = 'connection'
	  AND s."oauth2" IS NOT NULL
	  AND c."provider" = 'oauth2'
	  AND c."provider_state" ? 'clientIdSecretId'
	  AND coalesce(c."provider_state"->>'clientIdSecretId', '') <> ''
)
UPDATE "credential_binding" b
SET "secret_id" = r."secret_id",
    "text_value" = NULL,
    "connection_id" = NULL,
    "updated_at" = now()
FROM oauth_connections r
WHERE b."scope_id" = r."scope_id"
  AND b."plugin_id" = r."plugin_id"
  AND b."source_id" = r."source_id"
  AND b."source_scope_id" = r."source_scope_id"
  AND b."slot_key" = r."slot_key"
  AND b."kind" = 'secret';--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b."scope_id",
		b."id" AS "binding_id",
		b."plugin_id",
		b."source_id",
		b."source_scope_id",
		s."oauth2"->>'clientIdSlot' AS "slot_key",
		c."provider_state"->>'clientIdSecretId' AS "secret_id",
		b."created_at"
	FROM "credential_binding" b
	JOIN "openapi_source" s
	  ON s."id" = b."source_id"
	 AND s."scope_id" = b."source_scope_id"
	JOIN "connection" c
	  ON c."id" = b."connection_id"
	 AND c."scope_id" = b."scope_id"
	WHERE b."plugin_id" = 'openapi'
	  AND b."kind" = 'connection'
	  AND s."oauth2" IS NOT NULL
	  AND c."provider" = 'oauth2'
	  AND c."provider_state" ? 'clientIdSecretId'
	  AND coalesce(c."provider_state"->>'clientIdSecretId', '') <> ''
)
INSERT INTO "credential_binding" (
	"id",
	"scope_id",
	"plugin_id",
	"source_id",
	"source_scope_id",
	"slot_key",
	"kind",
	"text_value",
	"secret_id",
	"connection_id",
	"created_at",
	"updated_at"
)
SELECT
	'[' || to_jsonb('oconn-openapi-oauth-client'::text)::text || ',' || to_jsonb(r."binding_id")::text || ',' || to_jsonb(r."scope_id")::text || ',' || to_jsonb(r."slot_key")::text || ']',
	r."scope_id",
	r."plugin_id",
	r."source_id",
	r."source_scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	r."created_at",
	now()
FROM oauth_connections r
WHERE r."slot_key" IS NOT NULL
  AND NOT EXISTS (
		SELECT 1
		FROM "credential_binding" existing
		WHERE existing."scope_id" = r."scope_id"
		  AND existing."plugin_id" = r."plugin_id"
		  AND existing."source_id" = r."source_id"
		  AND existing."source_scope_id" = r."source_scope_id"
		  AND existing."slot_key" = r."slot_key"
	)
ON CONFLICT ("scope_id", "id") DO UPDATE SET
	"plugin_id" = excluded."plugin_id",
	"source_id" = excluded."source_id",
	"source_scope_id" = excluded."source_scope_id",
	"slot_key" = excluded."slot_key",
	"kind" = excluded."kind",
	"text_value" = excluded."text_value",
	"secret_id" = excluded."secret_id",
	"connection_id" = excluded."connection_id",
	"updated_at" = excluded."updated_at";--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b."scope_id",
		b."id" AS "binding_id",
		b."plugin_id",
		b."source_id",
		b."source_scope_id",
		coalesce(
			s."oauth2"->>'clientSecretSlot',
			'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':client-secret'
		) AS "slot_key",
		c."provider_state"->>'clientSecretSecretId' AS "secret_id",
		b."created_at"
	FROM "credential_binding" b
	JOIN "openapi_source" s
	  ON s."id" = b."source_id"
	 AND s."scope_id" = b."source_scope_id"
	JOIN "connection" c
	  ON c."id" = b."connection_id"
	 AND c."scope_id" = b."scope_id"
	WHERE b."plugin_id" = 'openapi'
	  AND b."kind" = 'connection'
	  AND s."oauth2" IS NOT NULL
	  AND c."provider" = 'oauth2'
	  AND c."provider_state" ? 'clientSecretSecretId'
	  AND coalesce(c."provider_state"->>'clientSecretSecretId', '') <> ''
)
UPDATE "credential_binding" b
SET "secret_id" = r."secret_id",
    "text_value" = NULL,
    "connection_id" = NULL,
    "updated_at" = now()
FROM oauth_connections r
WHERE b."scope_id" = r."scope_id"
  AND b."plugin_id" = r."plugin_id"
  AND b."source_id" = r."source_id"
  AND b."source_scope_id" = r."source_scope_id"
  AND b."slot_key" = r."slot_key"
  AND b."kind" = 'secret';--> statement-breakpoint

WITH oauth_connections AS (
	SELECT
		b."scope_id",
		b."id" AS "binding_id",
		b."plugin_id",
		b."source_id",
		b."source_scope_id",
		coalesce(
			s."oauth2"->>'clientSecretSlot',
			'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':client-secret'
		) AS "slot_key",
		c."provider_state"->>'clientSecretSecretId' AS "secret_id",
		b."created_at"
	FROM "credential_binding" b
	JOIN "openapi_source" s
	  ON s."id" = b."source_id"
	 AND s."scope_id" = b."source_scope_id"
	JOIN "connection" c
	  ON c."id" = b."connection_id"
	 AND c."scope_id" = b."scope_id"
	WHERE b."plugin_id" = 'openapi'
	  AND b."kind" = 'connection'
	  AND s."oauth2" IS NOT NULL
	  AND c."provider" = 'oauth2'
	  AND c."provider_state" ? 'clientSecretSecretId'
	  AND coalesce(c."provider_state"->>'clientSecretSecretId', '') <> ''
)
INSERT INTO "credential_binding" (
	"id",
	"scope_id",
	"plugin_id",
	"source_id",
	"source_scope_id",
	"slot_key",
	"kind",
	"text_value",
	"secret_id",
	"connection_id",
	"created_at",
	"updated_at"
)
SELECT
	'[' || to_jsonb('oconn-openapi-oauth-secret'::text)::text || ',' || to_jsonb(r."binding_id")::text || ',' || to_jsonb(r."scope_id")::text || ',' || to_jsonb(r."slot_key")::text || ']',
	r."scope_id",
	r."plugin_id",
	r."source_id",
	r."source_scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	r."created_at",
	now()
FROM oauth_connections r
WHERE r."slot_key" IS NOT NULL
  AND NOT EXISTS (
		SELECT 1
		FROM "credential_binding" existing
		WHERE existing."scope_id" = r."scope_id"
		  AND existing."plugin_id" = r."plugin_id"
		  AND existing."source_id" = r."source_id"
		  AND existing."source_scope_id" = r."source_scope_id"
		  AND existing."slot_key" = r."slot_key"
	)
ON CONFLICT ("scope_id", "id") DO UPDATE SET
	"plugin_id" = excluded."plugin_id",
	"source_id" = excluded."source_id",
	"source_scope_id" = excluded."source_scope_id",
	"slot_key" = excluded."slot_key",
	"kind" = excluded."kind",
	"text_value" = excluded."text_value",
	"secret_id" = excluded."secret_id",
	"connection_id" = excluded."connection_id",
	"updated_at" = excluded."updated_at";
