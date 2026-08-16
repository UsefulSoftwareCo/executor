ALTER TABLE "connection" ADD COLUMN "tools_stale_at" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_sync_claim_id" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_sync_claim_at" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_sync_failures" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_sync_retry_at" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_sync_error_kind" text;