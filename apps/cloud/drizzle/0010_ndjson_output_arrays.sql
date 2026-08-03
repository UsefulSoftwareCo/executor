-- Extraction used to persist an NDJSON operation's PER-LINE response schema
-- as the tool's output schema, while the invoke path returns an ARRAY of
-- parsed lines, so describe previews promised a single object invocations
-- never returned. The producer now wraps those schemas in an array. Persisted
-- `tool` rows can't be recognized as NDJSON-derived from their schema alone,
-- but the stored operation bindings kept the response content type, so the
-- affected connections are findable: stale-mark `tools_synced_at` and the
-- next read rebuilds their tool rows through the fixed producer.
--
-- Effectively idempotent: re-running re-marks the same connections, and a
-- rebuild from unchanged bindings writes identical rows.
UPDATE "connection" c
SET "tools_synced_at" = NULL
FROM (
  SELECT DISTINCT ps."tenant", ps."data"::jsonb ->> 'integration' AS integration
  FROM "plugin_storage" ps
  WHERE ps."collection" = 'operation'
    AND (ps."data"::text LIKE '%application/stream+json%'
      OR ps."data"::text LIKE '%application/x-ndjson%'
      OR ps."data"::text LIKE '%application/jsonl%')
) ndjson
WHERE c."tenant" = ndjson."tenant"
  AND c."integration" = ndjson."integration";
