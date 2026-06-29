ALTER TABLE "integration" ALTER COLUMN "description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "tools_synced_at" bigint;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "config_revised_at" bigint;--> statement-breakpoint
-- Pre-split rows kept the display name in `description`. Move it to `name`
-- (its proper home), then clear `description` so it no longer carries a
-- duplicated title — it now means an actual, optional description.
UPDATE "integration" SET "name" = "description" WHERE "name" IS NULL;--> statement-breakpoint
UPDATE "integration" SET "description" = NULL;
