CREATE TABLE "membership_tombstones" (
	"membership_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workos_sync" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "workos_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "membership_id" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "workos_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "membership_tombstones" ADD CONSTRAINT "membership_tombstones_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_tombstones" ADD CONSTRAINT "membership_tombstones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_tombstones_organization_id_idx" ON "membership_tombstones" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "accounts_email_lower_idx" ON "accounts" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_membership_id_unique" ON "memberships" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "memberships_organization_id_idx" ON "memberships" USING btree ("organization_id");