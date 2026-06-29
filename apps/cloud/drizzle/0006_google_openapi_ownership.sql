CREATE TEMP TABLE "__google_openapi_integrations" AS
SELECT
  "tenant",
  "slug",
  "config"::jsonb ->> 'specHash' AS "spec_hash"
FROM "integration"
WHERE "plugin_id" = 'openapi'
  AND "config" IS NOT NULL
  AND jsonb_typeof("config"::jsonb -> 'googleDiscoveryUrls') = 'array';--> statement-breakpoint
INSERT INTO "blob" ("namespace", "key", "value", "row_id", "id")
SELECT
  'o:' || g."tenant" || '/google' AS "namespace",
  b."key",
  b."value",
  'mig_google_blob_' || md5('o:' || g."tenant" || '/google' || ':' || b."key") AS "row_id",
  '["' || 'o:' || g."tenant" || '/google' || '","' || b."key" || '"]' AS "id"
FROM "__google_openapi_integrations" g
JOIN "blob" b
  ON b."namespace" = 'o:' || g."tenant" || '/openapi'
 AND b."key" = 'spec/' || g."spec_hash"
WHERE g."spec_hash" IS NOT NULL
  AND g."spec_hash" <> ''
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "plugin_storage"
  ("tenant", "owner", "subject", "plugin_id", "collection", "key", "data", "created_at", "updated_at", "row_id")
SELECT
  ps."tenant",
  ps."owner",
  ps."subject",
  'google',
  ps."collection",
  ps."key",
  ps."data",
  ps."created_at",
  ps."updated_at",
  'mig_google_storage_' || md5(ps."tenant" || ':' || ps."owner" || ':' || ps."subject" || ':' || ps."collection" || ':' || ps."key")
FROM "plugin_storage" ps
JOIN "__google_openapi_integrations" g
  ON g."tenant" = ps."tenant"
WHERE ps."plugin_id" = 'openapi'
  AND ps."collection" = 'operation'
  AND (
    ps."data"::jsonb ->> 'integration' = g."slug"
    OR ps."key" LIKE g."slug" || '.%'
  )
ON CONFLICT ("tenant", "owner", "subject", "plugin_id", "collection", "key")
DO UPDATE SET
  "data" = EXCLUDED."data",
  "updated_at" = EXCLUDED."updated_at";--> statement-breakpoint
DELETE FROM "plugin_storage" ps
USING "__google_openapi_integrations" g
WHERE ps."plugin_id" = 'openapi'
  AND ps."collection" = 'operation'
  AND g."tenant" = ps."tenant"
  AND (
    ps."data"::jsonb ->> 'integration' = g."slug"
    OR ps."key" LIKE g."slug" || '.%'
  );--> statement-breakpoint
UPDATE "tool"
SET "plugin_id" = 'google'
WHERE "plugin_id" = 'openapi'
  AND EXISTS (
    SELECT 1
    FROM "__google_openapi_integrations" g
    WHERE g."tenant" = "tool"."tenant"
      AND g."slug" = "tool"."integration"
  );--> statement-breakpoint
UPDATE "definition"
SET "plugin_id" = 'google'
WHERE "plugin_id" = 'openapi'
  AND EXISTS (
    SELECT 1
    FROM "__google_openapi_integrations" g
    WHERE g."tenant" = "definition"."tenant"
      AND g."slug" = "definition"."integration"
  );--> statement-breakpoint
UPDATE "integration"
SET "plugin_id" = 'google'
WHERE "plugin_id" = 'openapi'
  AND EXISTS (
    SELECT 1
    FROM "__google_openapi_integrations" g
    WHERE g."tenant" = "integration"."tenant"
      AND g."slug" = "integration"."slug"
  );--> statement-breakpoint
DROP TABLE "__google_openapi_integrations";
