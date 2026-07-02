ALTER TABLE "definition" ALTER COLUMN "name" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "last_health" json;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "health_check" json;