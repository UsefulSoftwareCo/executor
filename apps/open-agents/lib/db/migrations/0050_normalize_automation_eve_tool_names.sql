UPDATE "automation_versions"
SET "definition_json" = jsonb_set(
  "definition_json",
  '{policy,builtInTools}',
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb("normalized_tools"."tool") ORDER BY "normalized_tools"."first_ord")
      FROM (
        SELECT
          "mapped_tools"."tool",
          MIN("mapped_tools"."ord") AS "first_ord"
        FROM (
          SELECT
            CASE "raw_tools"."tool"
              WHEN 'todo_write' THEN 'todo'
              WHEN 'read' THEN 'read_file'
              WHEN 'write' THEN 'write_file'
              WHEN 'edit' THEN 'write_file'
              WHEN 'skill' THEN 'load_skill'
              ELSE "raw_tools"."tool"
            END AS "tool",
            "raw_tools"."ord"
          FROM jsonb_array_elements_text("definition_json" #> '{policy,builtInTools}')
            WITH ORDINALITY AS "raw_tools"("tool", "ord")
        ) AS "mapped_tools"
        WHERE "mapped_tools"."tool" IN (
          'todo',
          'read_file',
          'write_file',
          'grep',
          'glob',
          'bash',
          'web_fetch',
          'load_skill'
        )
        GROUP BY "mapped_tools"."tool"
      ) AS "normalized_tools"
    ),
    '[]'::jsonb
  ),
  true
)
WHERE jsonb_typeof("definition_json" #> '{policy,builtInTools}') = 'array';
--> statement-breakpoint
UPDATE "automation_runs"
SET "policy_snapshot_json" = jsonb_set(
  "policy_snapshot_json",
  '{builtInTools}',
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb("normalized_tools"."tool") ORDER BY "normalized_tools"."first_ord")
      FROM (
        SELECT
          "mapped_tools"."tool",
          MIN("mapped_tools"."ord") AS "first_ord"
        FROM (
          SELECT
            CASE "raw_tools"."tool"
              WHEN 'todo_write' THEN 'todo'
              WHEN 'read' THEN 'read_file'
              WHEN 'write' THEN 'write_file'
              WHEN 'edit' THEN 'write_file'
              WHEN 'skill' THEN 'load_skill'
              ELSE "raw_tools"."tool"
            END AS "tool",
            "raw_tools"."ord"
          FROM jsonb_array_elements_text("policy_snapshot_json" #> '{builtInTools}')
            WITH ORDINALITY AS "raw_tools"("tool", "ord")
        ) AS "mapped_tools"
        WHERE "mapped_tools"."tool" IN (
          'todo',
          'read_file',
          'write_file',
          'grep',
          'glob',
          'bash',
          'web_fetch',
          'load_skill'
        )
        GROUP BY "mapped_tools"."tool"
      ) AS "normalized_tools"
    ),
    '[]'::jsonb
  ),
  true
)
WHERE jsonb_typeof("policy_snapshot_json" #> '{builtInTools}') = 'array';
