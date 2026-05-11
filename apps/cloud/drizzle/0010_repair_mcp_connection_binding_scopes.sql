-- Repair MCP OAuth connection bindings created by the scoped credential cutover.
--
-- The cutover copied legacy mcp_source.auth_connection_id rows into
-- credential_binding at the source owner scope. For shared org MCP sources,
-- the referenced Connection rows are user-owned and live at user-org scope, so
-- those migrated bindings cannot resolve. Copy each invalid binding to every
-- matching user-org scope under the same org, then remove invalid rows that
-- still point at a scope without the referenced Connection.

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
	b."id",
	c."scope_id",
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
JOIN "connection" c
  ON c."id" = b."connection_id"
 AND c."scope_id" LIKE 'user-org:%:' || b."source_scope_id"
WHERE b."plugin_id" = 'mcp'
  AND b."kind" = 'connection'
  AND b."slot_key" = 'auth:oauth2:connection'
  AND NOT EXISTS (
		SELECT 1
		FROM "connection" exact
		WHERE exact."id" = b."connection_id"
		  AND exact."scope_id" = b."scope_id"
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

DELETE FROM "credential_binding" b
WHERE b."plugin_id" = 'mcp'
  AND b."kind" = 'connection'
  AND b."slot_key" = 'auth:oauth2:connection'
  AND NOT EXISTS (
		SELECT 1
		FROM "connection" c
		WHERE c."id" = b."connection_id"
		  AND c."scope_id" = b."scope_id"
	);--> statement-breakpoint
