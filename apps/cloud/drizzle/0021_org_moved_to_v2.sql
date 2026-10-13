CREATE TABLE "org_moved_to_v2" (
	"org_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"v2_org_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_moved_to_v2_state_check" CHECK ("org_moved_to_v2"."state" in ('moving', 'moved'))
);
--> statement-breakpoint
ALTER TABLE "org_moved_to_v2" ADD CONSTRAINT "org_moved_to_v2_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;