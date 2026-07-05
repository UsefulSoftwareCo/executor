ALTER TABLE "connection" ADD COLUMN "tools_sync_failure_count" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_sync_retry_after" bigint;
