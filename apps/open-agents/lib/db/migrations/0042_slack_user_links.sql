CREATE TABLE "slack_user_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_user_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_links_user_idx" ON "slack_user_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_links_identity_idx" ON "slack_user_links" USING btree ("slack_team_id","slack_user_id");