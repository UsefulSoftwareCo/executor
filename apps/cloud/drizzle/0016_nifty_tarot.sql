CREATE TABLE "access_group" (
	"id" varchar(255) NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_group_member" (
	"group_id" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "access_group" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "access_group_uidx" ON "access_group" USING btree ("tenant","id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_group_member_uidx" ON "access_group_member" USING btree ("tenant","group_id","subject");