-- Unwrap the retired {status, headers, data} transport envelope from
-- persisted OpenAPI tool output schemas. The runtime now returns the
-- upstream payload as `data` (status/headers moved to the ToolResult
-- `http` side channel), so persisted schemas must describe the payload
-- only. Rows produced before the envelope existed (pre-#854) are already
-- payload-shaped and don't match the predicates; re-running is a no-op.
--
-- The old producer emitted `"data": {}` when an operation declared no
-- response schema; the new producer persists NULL for those.
--
-- output_schema is a `json` column, so structural comparisons cast to
-- jsonb (json has no equality operator).
UPDATE "tool"
SET "output_schema" = CASE
  WHEN ("output_schema" -> 'properties' -> 'data')::jsonb = '{}'::jsonb THEN NULL
  ELSE "output_schema" -> 'properties' -> 'data'
END
WHERE "plugin_id" = 'openapi'
  AND "output_schema" IS NOT NULL
  AND "output_schema" ->> 'type' = 'object'
  AND ("output_schema" -> 'required')::jsonb = '["status", "headers", "data"]'::jsonb
  AND ("output_schema" -> 'properties' -> 'status')::jsonb = '{"type": "integer"}'::jsonb
  AND ("output_schema" -> 'properties' -> 'headers')::jsonb = '{"type": "object", "additionalProperties": {"type": "string"}}'::jsonb;
