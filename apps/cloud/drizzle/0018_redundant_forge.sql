CREATE TABLE "audit_event" (
	"id" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_owner" text,
	"resource_parent" text,
	"resource_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_uidx" ON "audit_event" USING btree ("tenant","created_at","id");