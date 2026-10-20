CREATE TABLE "delegation_notification" (
	"id" varchar(255) NOT NULL,
	"grant_id" varchar(255) NOT NULL,
	"credential_id" varchar(255) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"target_subject" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"credential_kind" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"read_at" bigint,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_notification_uidx" ON "delegation_notification" USING btree ("tenant","id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_notification_grant_target_uidx" ON "delegation_notification" USING btree ("tenant","grant_id","target_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_delegation_issued_key_ref_uidx" ON "credential_delegation" USING btree ("tenant","issued_key_ref");