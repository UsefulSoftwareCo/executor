CREATE TABLE "audit_event" (
	"id" varchar(255) NOT NULL,
	"actor_id" varchar(255),
	"action" varchar(255) NOT NULL,
	"resource_type" varchar(255) NOT NULL,
	"resource_owner" varchar(255),
	"resource_parent" text,
	"resource_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_uidx" ON "audit_event" USING btree ("tenant","created_at","id");