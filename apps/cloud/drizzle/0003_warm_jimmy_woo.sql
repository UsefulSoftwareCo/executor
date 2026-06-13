ALTER TABLE "connection" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_synced_at" bigint;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "tools_revised_at" bigint;