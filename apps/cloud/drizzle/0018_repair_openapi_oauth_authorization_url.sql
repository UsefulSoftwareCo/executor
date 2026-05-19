UPDATE "plugin_storage"
SET
  "data" = jsonb_set("data"::jsonb, '{config,oauth2,authorizationUrl}', 'null'::jsonb, true)::json,
  "updated_at" = now()
WHERE
  "plugin_id" = 'openapi'
  AND "collection" = 'source'
  AND "data" #> '{config,oauth2}' IS NOT NULL
  AND NOT ("data"::jsonb #> '{config,oauth2}' ? 'authorizationUrl');
