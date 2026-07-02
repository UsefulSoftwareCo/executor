ALTER TABLE "oauth_client" ADD COLUMN "origin_kind" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "origin_integration" text;
