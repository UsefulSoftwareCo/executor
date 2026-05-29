INSERT INTO "plugin_storage" (
  "row_id",
  "id",
  "scope_id",
  "plugin_id",
  "collection",
  "key",
  "data",
  "created_at",
  "updated_at"
)
SELECT
  'plugin_storage_' || md5('workosVault:metadata:' || m."scope_id" || ':' || m."id"),
  '["workosVault","metadata",' || to_json(m."id")::text || ']',
  m."scope_id",
  'workosVault',
  'metadata',
  m."id",
  json_build_object('name', m."name", 'purpose', m."purpose", 'createdAt', m."created_at"),
  m."created_at",
  now()
FROM "workos_vault_metadata" m
ON CONFLICT ("scope_id", "id") DO UPDATE SET
  "data" = EXCLUDED."data",
  "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint

DROP TABLE IF EXISTS "workos_vault_metadata";
