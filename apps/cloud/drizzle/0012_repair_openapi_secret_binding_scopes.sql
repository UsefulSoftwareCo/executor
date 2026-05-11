-- Repair OpenAPI secret bindings that point at scopes without the referenced
-- Secret row.
--
-- Most affected rows are user-org bindings for shared org sources where the
-- backing Secret lives at the source/org scope. A smaller case is the inverse:
-- an org binding whose matching Secret is user-owned under the same org. Copy
-- each invalid binding to the matching in-org Secret scope, then remove any
-- invalid OpenAPI secret binding that still has no Secret at its own scope.
-- This deliberately does not copy secrets across org boundaries.

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
SELECT DISTINCT ON (s."scope_id", b."id")
	b."id",
	s."scope_id",
	b."plugin_id",
	b."source_id",
	b."source_scope_id",
	b."slot_key",
	b."kind",
	b."text_value",
	b."secret_id",
	b."connection_id",
	b."created_at",
	now()
FROM "credential_binding" b
JOIN "secret" s
  ON s."id" = b."secret_id"
 AND (
		s."scope_id" = b."source_scope_id"
		OR s."scope_id" LIKE 'user-org:%:' || b."source_scope_id"
	)
WHERE b."plugin_id" = 'openapi'
  AND b."kind" = 'secret'
  AND NOT EXISTS (
		SELECT 1
		FROM "secret" exact
		WHERE exact."id" = b."secret_id"
		  AND exact."scope_id" = b."scope_id"
	)
ORDER BY s."scope_id", b."id", b."updated_at" DESC
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

DELETE FROM "credential_binding" b
WHERE b."plugin_id" = 'openapi'
  AND b."kind" = 'secret'
  AND NOT EXISTS (
		SELECT 1
		FROM "secret" s
		WHERE s."id" = b."secret_id"
		  AND s."scope_id" = b."scope_id"
	);--> statement-breakpoint
