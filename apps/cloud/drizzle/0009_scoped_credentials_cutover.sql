-- cloud scoped credential/source-slot/OAuth cutover.
-- Squashes the PR-local migration chain into one runtime schema transition.
-- 0009_add_credential_binding.sql
CREATE TABLE "credential_binding" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_scope_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"connection_id" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "credential_binding_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
ALTER TABLE "graphql_source" ALTER COLUMN "auth_kind" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "openapi_source_binding" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "credential_binding_scope_id_idx" ON "credential_binding" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "credential_binding_plugin_id_idx" ON "credential_binding" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "credential_binding_source_id_idx" ON "credential_binding" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "credential_binding_source_scope_id_idx" ON "credential_binding" USING btree ("source_scope_id");--> statement-breakpoint
CREATE INDEX "credential_binding_slot_key_idx" ON "credential_binding" USING btree ("slot_key");--> statement-breakpoint
CREATE INDEX "credential_binding_kind_idx" ON "credential_binding" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "credential_binding_secret_id_idx" ON "credential_binding" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "credential_binding_connection_id_idx" ON "credential_binding" USING btree ("connection_id");--> statement-breakpoint

CREATE FUNCTION pg_temp.executor_credential_binding_id(plugin_id text, source_scope_id text, source_id text, slot_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT '[' || to_jsonb($1)::text || ',' || to_jsonb($2)::text || ',' || to_jsonb($3)::text || ',' || to_jsonb($4)::text || ']'
$$;--> statement-breakpoint

-- 0010_migrate_openapi_source_bindings.sql
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
	pg_temp.executor_credential_binding_id('openapi', "source_scope_id", "source_id", "slot"),
	"target_scope_id",
	'openapi',
	"source_id",
	"source_scope_id",
	"slot",
	"kind",
	"text_value",
	"secret_id",
	"connection_id",
	"created_at",
	"updated_at"
FROM "openapi_source_binding"
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
DROP TABLE "openapi_source_binding" CASCADE;--> statement-breakpoint

-- 0011_openapi_credential_slots.sql
-- Convert OpenAPI's remaining direct credential references to source-owned
-- slot structure plus shared core credential_binding rows. Runtime code only
-- reads the final slot model; this migration is the one-shot bridge.

CREATE TEMP TABLE "__openapi_header_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__openapi_header_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	s."scope_id",
	s."id",
	'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h.key), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "openapi_source" s, jsonb_each(s."headers") h
WHERE s."headers" IS NOT NULL
  AND jsonb_typeof(h.value) = 'object'
  AND NOT (h.value ? 'kind')
  AND h.value ? 'secretId';--> statement-breakpoint

DROP TABLE "__openapi_header_slot_preflight";--> statement-breakpoint

WITH header_rows AS (
	SELECT
		s."scope_id",
		s."id" AS "source_id",
		h.key AS "name",
		'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h.key), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		h.value->>'secretId' AS "secret_id"
	FROM "openapi_source" s, jsonb_each(s."headers") h
	WHERE s."headers" IS NOT NULL
	  AND jsonb_typeof(h.value) = 'object'
	  AND NOT (h.value ? 'kind')
	  AND h.value ? 'secretId'
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM header_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."slot_key"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "openapi_source" s
SET "headers" = (
	SELECT jsonb_object_agg(
		h.key,
		CASE
			WHEN jsonb_typeof(h.value) = 'object'
			  AND NOT (h.value ? 'kind')
			  AND h.value ? 'secretId'
				THEN jsonb_strip_nulls(jsonb_build_object(
					'kind', 'binding',
					'slot', 'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h.key), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
					'prefix', h.value->>'prefix'
				))
			ELSE h.value
		END
	)
	FROM jsonb_each(s."headers") h
)
WHERE s."headers" IS NOT NULL;--> statement-breakpoint

WITH oauth_rows AS (
	SELECT
		s."scope_id",
		s."id" AS "source_id",
		'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':client-id' AS "client_id_slot",
		s."oauth2"->>'clientIdSecretId' AS "client_id_secret_id"
	FROM "openapi_source" s
	WHERE s."oauth2" IS NOT NULL
	  AND s."oauth2"->>'connectionId' IS NOT NULL
	  AND s."oauth2"->>'clientIdSecretId' IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."client_id_slot"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."client_id_slot",
	'secret',
	NULL,
	r."client_id_secret_id",
	NULL,
	now(),
	now()
FROM oauth_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."client_id_slot"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

WITH oauth_rows AS (
	SELECT
		s."scope_id",
		s."id" AS "source_id",
		'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':client-secret' AS "client_secret_slot",
		s."oauth2"->>'clientSecretSecretId' AS "client_secret_secret_id"
	FROM "openapi_source" s
	WHERE s."oauth2" IS NOT NULL
	  AND s."oauth2"->>'connectionId' IS NOT NULL
	  AND s."oauth2"->>'clientSecretSecretId' IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."client_secret_slot"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."client_secret_slot",
	'secret',
	NULL,
	r."client_secret_secret_id",
	NULL,
	now(),
	now()
FROM oauth_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."client_secret_slot"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

WITH oauth_rows AS (
	SELECT
		s."scope_id",
		s."id" AS "source_id",
		'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':connection' AS "connection_slot",
		s."oauth2"->>'connectionId' AS "connection_id"
	FROM "openapi_source" s
	WHERE s."oauth2" IS NOT NULL
	  AND s."oauth2"->>'connectionId' IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."connection_slot"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."connection_slot",
	'connection',
	NULL,
	NULL,
	r."connection_id",
	now(),
	now()
FROM oauth_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."connection_slot"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "openapi_source" s
SET "oauth2" = jsonb_build_object(
	'kind', 'oauth2',
	'securitySchemeName', s."oauth2"->>'securitySchemeName',
	'flow', s."oauth2"->>'flow',
	'tokenUrl', s."oauth2"->>'tokenUrl',
	'authorizationUrl', s."oauth2"->'authorizationUrl',
	'issuerUrl', s."oauth2"->'issuerUrl',
	'clientIdSlot', 'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':client-id',
	'clientSecretSlot',
		CASE
			WHEN s."oauth2"->>'clientSecretSecretId' IS NULL THEN NULL
			ELSE 'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':client-secret'
		END,
	'connectionSlot', 'oauth2:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(s."oauth2"->>'securitySchemeName'), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') || ':connection',
	'scopes', COALESCE(s."oauth2"->'scopes', '[]'::jsonb)
)
WHERE s."oauth2" IS NOT NULL
  AND s."oauth2"->>'connectionId' IS NOT NULL;--> statement-breakpoint

CREATE TEMP TABLE "__openapi_query_param_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__openapi_query_param_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	r."scope_id",
	r."source_id",
	'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(r."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "openapi_source_query_param" r
WHERE r."kind" = 'secret' AND r."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__openapi_query_param_slot_preflight";--> statement-breakpoint

WITH rows AS (
	SELECT
		r."scope_id",
		r."source_id",
		'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(r."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		r."secret_id"
	FROM "openapi_source_query_param" r
	WHERE r."kind" = 'secret' AND r."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."slot_key"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "openapi_source_query_param" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "openapi_source_query_param" ADD COLUMN "prefix" text;--> statement-breakpoint
UPDATE "openapi_source_query_param"
SET
	"slot_key" = 'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"kind" = 'binding'
WHERE "kind" = 'secret';--> statement-breakpoint
DROP INDEX IF EXISTS "openapi_source_query_param_secret_id_idx";--> statement-breakpoint
ALTER TABLE "openapi_source_query_param" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "openapi_source_query_param" DROP COLUMN "secret_prefix";--> statement-breakpoint

CREATE TEMP TABLE "__openapi_spec_fetch_header_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__openapi_spec_fetch_header_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	r."scope_id",
	r."source_id",
	'spec_fetch_header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(r."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "openapi_source_spec_fetch_header" r
WHERE r."kind" = 'secret' AND r."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__openapi_spec_fetch_header_slot_preflight";--> statement-breakpoint

WITH rows AS (
	SELECT
		r."scope_id",
		r."source_id",
		'spec_fetch_header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(r."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		r."secret_id"
	FROM "openapi_source_spec_fetch_header" r
	WHERE r."kind" = 'secret' AND r."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."slot_key"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "openapi_source_spec_fetch_header" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "openapi_source_spec_fetch_header" ADD COLUMN "prefix" text;--> statement-breakpoint
UPDATE "openapi_source_spec_fetch_header"
SET
	"slot_key" = 'spec_fetch_header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"kind" = 'binding'
WHERE "kind" = 'secret';--> statement-breakpoint
DROP INDEX IF EXISTS "openapi_source_spec_fetch_header_secret_id_idx";--> statement-breakpoint
ALTER TABLE "openapi_source_spec_fetch_header" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "openapi_source_spec_fetch_header" DROP COLUMN "secret_prefix";--> statement-breakpoint

CREATE TEMP TABLE "__openapi_spec_fetch_query_param_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__openapi_spec_fetch_query_param_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	r."scope_id",
	r."source_id",
	'spec_fetch_query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(r."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "openapi_source_spec_fetch_query_param" r
WHERE r."kind" = 'secret' AND r."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__openapi_spec_fetch_query_param_slot_preflight";--> statement-breakpoint

WITH rows AS (
	SELECT
		r."scope_id",
		r."source_id",
		'spec_fetch_query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(r."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		r."secret_id"
	FROM "openapi_source_spec_fetch_query_param" r
	WHERE r."kind" = 'secret' AND r."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."slot_key"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "openapi_source_spec_fetch_query_param" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "openapi_source_spec_fetch_query_param" ADD COLUMN "prefix" text;--> statement-breakpoint
UPDATE "openapi_source_spec_fetch_query_param"
SET
	"slot_key" = 'spec_fetch_query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"kind" = 'binding'
WHERE "kind" = 'secret';--> statement-breakpoint
DROP INDEX IF EXISTS "openapi_source_spec_fetch_query_param_secret_id_idx";--> statement-breakpoint
ALTER TABLE "openapi_source_spec_fetch_query_param" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "openapi_source_spec_fetch_query_param" DROP COLUMN "secret_prefix";--> statement-breakpoint

-- 0012_graphql_credential_slots.sql
-- Convert GraphQL's direct credential references to source-owned slot
-- structure plus shared core credential_binding rows. Runtime code only
-- reads the final slot model; this migration is the one-shot bridge.

DROP INDEX "graphql_source_auth_connection_id_idx";--> statement-breakpoint
DROP INDEX "graphql_source_header_secret_id_idx";--> statement-breakpoint
DROP INDEX "graphql_source_query_param_secret_id_idx";--> statement-breakpoint

ALTER TABLE "graphql_source" ADD COLUMN "auth_connection_slot" text;--> statement-breakpoint

UPDATE "graphql_source"
SET "auth_connection_slot" = 'auth:oauth2:connection'
WHERE "auth_kind" = 'oauth2'
  AND "auth_connection_id" IS NOT NULL;--> statement-breakpoint

INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('graphql', s."scope_id", s."id", 'auth:oauth2:connection'),
	s."scope_id",
	'graphql',
	s."id",
	s."scope_id",
	'auth:oauth2:connection',
	'connection',
	NULL,
	NULL,
	s."auth_connection_id",
	now(),
	now()
FROM "graphql_source" s
WHERE s."auth_kind" = 'oauth2'
  AND s."auth_connection_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "graphql_source" DROP COLUMN "auth_connection_id";--> statement-breakpoint

ALTER TABLE "graphql_source_header" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "graphql_source_header" ADD COLUMN "prefix" text;--> statement-breakpoint

CREATE TEMP TABLE "__graphql_header_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__graphql_header_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	h."scope_id",
	h."source_id",
	'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "graphql_source_header" h
WHERE h."kind" = 'secret'
  AND h."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__graphql_header_slot_preflight";--> statement-breakpoint

WITH header_rows AS (
	SELECT
		h."scope_id",
		h."source_id",
		h."name",
		'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		h."secret_id",
		h."secret_prefix"
	FROM "graphql_source_header" h
	WHERE h."kind" = 'secret'
	  AND h."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('graphql', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'graphql',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM header_rows r
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "graphql_source_header"
SET
	"kind" = 'binding',
	"slot_key" = 'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"text_value" = NULL
WHERE "kind" = 'secret'
  AND "secret_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "graphql_source_header" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "graphql_source_header" DROP COLUMN "secret_prefix";--> statement-breakpoint

ALTER TABLE "graphql_source_query_param" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "graphql_source_query_param" ADD COLUMN "prefix" text;--> statement-breakpoint

CREATE TEMP TABLE "__graphql_query_param_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__graphql_query_param_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	q."scope_id",
	q."source_id",
	'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(q."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "graphql_source_query_param" q
WHERE q."kind" = 'secret'
  AND q."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__graphql_query_param_slot_preflight";--> statement-breakpoint

WITH query_param_rows AS (
	SELECT
		q."scope_id",
		q."source_id",
		q."name",
		'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(q."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		q."secret_id",
		q."secret_prefix"
	FROM "graphql_source_query_param" q
	WHERE q."kind" = 'secret'
	  AND q."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('graphql', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'graphql',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM query_param_rows r
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "graphql_source_query_param"
SET
	"kind" = 'binding',
	"slot_key" = 'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"text_value" = NULL
WHERE "kind" = 'secret'
  AND "secret_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "graphql_source_query_param" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "graphql_source_query_param" DROP COLUMN "secret_prefix";--> statement-breakpoint

-- 0013_mcp_credential_slots.sql
-- Convert MCP direct credential references to source-owned slot structure
-- plus shared core credential_binding rows. Runtime code only reads the
-- final slot model; this migration is the one-shot bridge from old data.

DROP INDEX "mcp_source_auth_secret_id_idx";--> statement-breakpoint
DROP INDEX "mcp_source_auth_connection_id_idx";--> statement-breakpoint
DROP INDEX "mcp_source_auth_client_id_secret_id_idx";--> statement-breakpoint
DROP INDEX "mcp_source_auth_client_secret_secret_id_idx";--> statement-breakpoint
DROP INDEX "mcp_source_header_secret_id_idx";--> statement-breakpoint
DROP INDEX "mcp_source_query_param_secret_id_idx";--> statement-breakpoint

ALTER TABLE "mcp_source" ADD COLUMN "auth_header_slot" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_header_prefix" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_connection_slot" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_client_id_slot" text;--> statement-breakpoint
ALTER TABLE "mcp_source" ADD COLUMN "auth_client_secret_slot" text;--> statement-breakpoint

UPDATE "mcp_source"
SET
	"auth_header_slot" = 'auth:header',
	"auth_header_prefix" = "auth_secret_prefix"
WHERE "auth_kind" = 'header'
  AND "auth_secret_id" IS NOT NULL;--> statement-breakpoint

INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('mcp', s."scope_id", s."id", 'auth:header'),
	s."scope_id",
	'mcp',
	s."id",
	s."scope_id",
	'auth:header',
	'secret',
	NULL,
	s."auth_secret_id",
	NULL,
	now(),
	now()
FROM "mcp_source" s
WHERE s."auth_kind" = 'header'
  AND s."auth_secret_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "mcp_source"
SET
	"auth_connection_slot" = 'auth:oauth2:connection',
	"auth_client_id_slot" = CASE
		WHEN "auth_client_id_secret_id" IS NOT NULL THEN 'auth:oauth2:client-id'
		ELSE NULL
	END,
	"auth_client_secret_slot" = CASE
		WHEN "auth_client_secret_secret_id" IS NOT NULL THEN 'auth:oauth2:client-secret'
		ELSE NULL
	END
WHERE "auth_kind" = 'oauth2'
  AND "auth_connection_id" IS NOT NULL;--> statement-breakpoint

INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('mcp', s."scope_id", s."id", 'auth:oauth2:connection'),
	s."scope_id",
	'mcp',
	s."id",
	s."scope_id",
	'auth:oauth2:connection',
	'connection',
	NULL,
	NULL,
	s."auth_connection_id",
	now(),
	now()
FROM "mcp_source" s
WHERE s."auth_kind" = 'oauth2'
  AND s."auth_connection_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('mcp', s."scope_id", s."id", 'auth:oauth2:client-id'),
	s."scope_id",
	'mcp',
	s."id",
	s."scope_id",
	'auth:oauth2:client-id',
	'secret',
	NULL,
	s."auth_client_id_secret_id",
	NULL,
	now(),
	now()
FROM "mcp_source" s
WHERE s."auth_kind" = 'oauth2'
  AND s."auth_client_id_secret_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('mcp', s."scope_id", s."id", 'auth:oauth2:client-secret'),
	s."scope_id",
	'mcp',
	s."id",
	s."scope_id",
	'auth:oauth2:client-secret',
	'secret',
	NULL,
	s."auth_client_secret_secret_id",
	NULL,
	now(),
	now()
FROM "mcp_source" s
WHERE s."auth_kind" = 'oauth2'
  AND s."auth_client_secret_secret_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "mcp_source" DROP COLUMN "auth_secret_id";--> statement-breakpoint
ALTER TABLE "mcp_source" DROP COLUMN "auth_secret_prefix";--> statement-breakpoint
ALTER TABLE "mcp_source" DROP COLUMN "auth_connection_id";--> statement-breakpoint
ALTER TABLE "mcp_source" DROP COLUMN "auth_client_id_secret_id";--> statement-breakpoint
ALTER TABLE "mcp_source" DROP COLUMN "auth_client_secret_secret_id";--> statement-breakpoint

ALTER TABLE "mcp_source_header" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "mcp_source_header" ADD COLUMN "prefix" text;--> statement-breakpoint

CREATE TEMP TABLE "__mcp_header_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__mcp_header_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	h."scope_id",
	h."source_id",
	'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "mcp_source_header" h
WHERE h."kind" = 'secret'
  AND h."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__mcp_header_slot_preflight";--> statement-breakpoint

WITH header_rows AS (
	SELECT
		h."scope_id",
		h."source_id",
		h."name",
		'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		h."secret_id",
		h."secret_prefix"
	FROM "mcp_source_header" h
	WHERE h."kind" = 'secret'
	  AND h."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('mcp', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'mcp',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM header_rows r
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "mcp_source_header"
SET
	"kind" = 'binding',
	"slot_key" = 'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"text_value" = NULL
WHERE "kind" = 'secret'
  AND "secret_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "mcp_source_header" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "mcp_source_header" DROP COLUMN "secret_prefix";--> statement-breakpoint

ALTER TABLE "mcp_source_query_param" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "mcp_source_query_param" ADD COLUMN "prefix" text;--> statement-breakpoint

CREATE TEMP TABLE "__mcp_query_param_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__mcp_query_param_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	q."scope_id",
	q."source_id",
	'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(q."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "mcp_source_query_param" q
WHERE q."kind" = 'secret'
  AND q."secret_id" IS NOT NULL;--> statement-breakpoint

DROP TABLE "__mcp_query_param_slot_preflight";--> statement-breakpoint

WITH query_param_rows AS (
	SELECT
		q."scope_id",
		q."source_id",
		q."name",
		'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(q."name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		q."secret_id",
		q."secret_prefix"
	FROM "mcp_source_query_param" q
	WHERE q."kind" = 'secret'
	  AND q."secret_id" IS NOT NULL
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('mcp', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'mcp',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM query_param_rows r
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "mcp_source_query_param"
SET
	"kind" = 'binding',
	"slot_key" = 'query_param:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default'),
	"prefix" = "secret_prefix",
	"text_value" = NULL
WHERE "kind" = 'secret'
  AND "secret_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "mcp_source_query_param" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "mcp_source_query_param" DROP COLUMN "secret_prefix";--> statement-breakpoint

-- 0014_normalize_oauth_connections.sql
-- Normalize pre-unified OAuth connection rows to the canonical core
-- provider/provider_state shape. Runtime refresh only reads provider='oauth2'
-- and provider_state.kind after this one-shot data migration.

UPDATE "connection"
SET
  "provider" = 'oauth2',
  "provider_state" = jsonb_build_object(
    'kind', CASE "provider_state"->>'flow'
      WHEN 'authorizationCode' THEN 'authorization-code'
      ELSE 'client-credentials'
    END,
    'tokenEndpoint', "provider_state"->>'tokenUrl',
    'issuerUrl', NULL,
    'clientIdSecretId', "provider_state"->>'clientIdSecretId',
    'clientSecretSecretId', CASE "provider_state"->>'flow'
      WHEN 'clientCredentials' THEN coalesce("provider_state"->>'clientSecretSecretId', '')
      ELSE "provider_state"->>'clientSecretSecretId'
    END,
    'clientAuth', 'body',
    'scopes', coalesce("provider_state"->'scopes', '[]'::jsonb),
    'scope', "scope"
  ),
  "updated_at" = now()
WHERE "provider" = 'openapi:oauth2'
  AND "provider_state"->>'flow' IN ('authorizationCode', 'clientCredentials');--> statement-breakpoint

UPDATE "connection"
SET
  "provider" = 'oauth2',
  "provider_state" = jsonb_build_object(
    'kind', 'dynamic-dcr',
    'tokenEndpoint', coalesce(
      "provider_state"->>'tokenEndpoint',
      "provider_state"#>>'{authorizationServerMetadata,token_endpoint}',
      ''
    ),
    'issuerUrl', "provider_state"#>>'{authorizationServerMetadata,issuer}',
    'authorizationServerUrl', "provider_state"->>'authorizationServerUrl',
    'authorizationServerMetadataUrl', "provider_state"->>'authorizationServerMetadataUrl',
    'idTokenSigningAlgValuesSupported', coalesce(
      "provider_state"#>'{authorizationServerMetadata,id_token_signing_alg_values_supported}',
      '[]'::jsonb
    ),
    'clientId', coalesce("provider_state"#>>'{clientInformation,client_id}', ''),
    'clientSecretSecretId', NULL,
    'clientAuth', CASE "provider_state"#>>'{clientInformation,token_endpoint_auth_method}'
      WHEN 'client_secret_basic' THEN 'basic'
      ELSE 'body'
    END,
    'scopes', '[]'::jsonb,
    'scope', "scope",
    'resource', "provider_state"->>'endpoint'
  ),
  "updated_at" = now()
WHERE "provider" = 'mcp:oauth2';--> statement-breakpoint

-- 0015_openapi_header_rows.sql
-- Move OpenAPI request headers out of openapi_source.headers JSON and into
-- the same child-row slot model used by query params and spec-fetch
-- credentials. Runtime code reads only openapi_source_header after this.

CREATE TABLE "openapi_source_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "openapi_source_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);--> statement-breakpoint
CREATE INDEX "openapi_source_header_scope_id_idx" ON "openapi_source_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_header_source_id_idx" ON "openapi_source_header" USING btree ("source_id");--> statement-breakpoint

CREATE TEMP TABLE "__openapi_header_row_slot_preflight" (
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"slot_key" text NOT NULL,
	PRIMARY KEY ("scope_id", "source_id", "slot_key")
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "__openapi_header_row_slot_preflight" ("scope_id", "source_id", "slot_key")
SELECT
	s."scope_id",
	s."id",
	'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h.key), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key"
FROM "openapi_source" s, jsonb_each(s."headers") h
WHERE s."headers" IS NOT NULL
  AND jsonb_typeof(h.value) = 'object'
  AND h.value ? 'secretId'
  AND COALESCE(h.value->>'kind', 'secret') = 'secret';--> statement-breakpoint

DROP TABLE "__openapi_header_row_slot_preflight";--> statement-breakpoint

WITH header_rows AS (
	SELECT
		s."scope_id",
		s."id" AS "source_id",
		h.key AS "name",
		'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h.key), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default') AS "slot_key",
		h.value->>'secretId' AS "secret_id"
	FROM "openapi_source" s, jsonb_each(s."headers") h
	WHERE s."headers" IS NOT NULL
	  AND jsonb_typeof(h.value) = 'object'
	  AND h.value ? 'secretId'
	  AND COALESCE(h.value->>'kind', 'secret') = 'secret'
)
INSERT INTO "credential_binding" (
	"id", "scope_id", "plugin_id", "source_id", "source_scope_id", "slot_key",
	"kind", "text_value", "secret_id", "connection_id", "created_at", "updated_at"
)
SELECT
	pg_temp.executor_credential_binding_id('openapi', r."scope_id", r."source_id", r."slot_key"),
	r."scope_id",
	'openapi',
	r."source_id",
	r."scope_id",
	r."slot_key",
	'secret',
	NULL,
	r."secret_id",
	NULL,
	now(),
	now()
FROM header_rows r
WHERE NOT EXISTS (
	SELECT 1 FROM "credential_binding" b
	WHERE b."scope_id" = r."scope_id"
	  AND b."plugin_id" = 'openapi'
	  AND b."source_id" = r."source_id"
	  AND b."source_scope_id" = r."scope_id"
	  AND b."slot_key" = r."slot_key"
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "openapi_source_header" (
	"id", "scope_id", "source_id", "name", "kind", "text_value", "slot_key", "prefix"
)
SELECT
	jsonb_build_array(s."id", h.key)::text,
	s."scope_id",
	s."id",
	h.key,
	CASE
		WHEN jsonb_typeof(h.value) = 'string' THEN 'text'
		WHEN jsonb_typeof(h.value) = 'object' AND h.value->>'kind' = 'text' THEN 'text'
		ELSE 'binding'
	END,
	CASE
		WHEN jsonb_typeof(h.value) = 'string' THEN h.value #>> '{}'
		WHEN jsonb_typeof(h.value) = 'object' AND h.value->>'kind' = 'text'
			THEN h.value->>'text'
		ELSE NULL
	END,
	CASE
		WHEN jsonb_typeof(h.value) = 'object' AND h.value->>'kind' = 'binding'
			THEN h.value->>'slot'
		WHEN jsonb_typeof(h.value) = 'object' AND h.value ? 'secretId'
			THEN 'header:' || COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(trim(h.key), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'default')
		ELSE NULL
	END,
	CASE
		WHEN jsonb_typeof(h.value) = 'object'
			THEN COALESCE(h.value->>'prefix', h.value->>'secretPrefix')
		ELSE NULL
	END
FROM "openapi_source" s, jsonb_each(s."headers") h
WHERE s."headers" IS NOT NULL
  AND (
	jsonb_typeof(h.value) = 'string'
	OR (
		jsonb_typeof(h.value) = 'object'
		AND (
			h.value->>'kind' IN ('binding', 'text')
			OR h.value ? 'secretId'
		)
	)
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "openapi_source" DROP COLUMN "headers";
