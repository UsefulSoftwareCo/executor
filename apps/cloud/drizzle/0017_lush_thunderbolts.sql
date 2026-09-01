ALTER TABLE "connection" ADD COLUMN "credential_write" json;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "credential_write" json;