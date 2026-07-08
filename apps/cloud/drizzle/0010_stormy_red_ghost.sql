ALTER TABLE "connection" ADD COLUMN "tools_sync_error" json;--> statement-breakpoint
UPDATE "connection"
SET "last_health" = NULL
WHERE "last_health"::jsonb ->> 'detail' LIKE 'Tool sync failing%';
