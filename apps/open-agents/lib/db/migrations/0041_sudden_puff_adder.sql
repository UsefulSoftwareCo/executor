CREATE TABLE "agent_library_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"item_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_library_items" ADD CONSTRAINT "agent_library_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_library_items_user_kind_idx" ON "agent_library_items" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_library_items_user_kind_item_idx" ON "agent_library_items" USING btree ("user_id","kind","item_id");