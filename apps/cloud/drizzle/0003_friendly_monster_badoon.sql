ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");