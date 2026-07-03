DROP INDEX "agent_library_items_user_kind_item_idx";--> statement-breakpoint
ALTER TABLE "agent_library_items" ADD COLUMN "scope_kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_library_items" ADD COLUMN "scope_id" text;--> statement-breakpoint
UPDATE "agent_library_items" SET "scope_id" = "user_id" WHERE "scope_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_library_items" ALTER COLUMN "scope_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_library_items_scope_kind_scope_id_kind_idx" ON "agent_library_items" USING btree ("scope_kind","scope_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_library_items_scope_kind_scope_id_kind_item_idx" ON "agent_library_items" USING btree ("scope_kind","scope_id","kind","item_id");