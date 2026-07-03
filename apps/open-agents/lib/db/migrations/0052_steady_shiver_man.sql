CREATE TABLE IF NOT EXISTS "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "organization_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"slack_team_id" text,
	"slack_channel_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_members" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"source" text NOT NULL,
	"added_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id"),
	CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "group_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "docs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'design_doc' NOT NULL,
	"markdown_cache" text,
	"markdown_cache_seq" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "scope_kind" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "scope_id" text;
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "scope_kind" text;
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "scope_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_members_user_idx" ON "organization_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "groups_org_idx" ON "groups" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "groups_slack_channel_idx" ON "groups" USING btree ("org_id","slack_team_id","slack_channel_id") WHERE "groups"."source" = 'slack_channel';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_members_user_idx" ON "group_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_scope_idx" ON "docs" USING btree ("scope_kind","scope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_created_by_idx" ON "docs" USING btree ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_scope_idx" ON "sessions" USING btree ("scope_kind","scope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_scope_idx" ON "chats" USING btree ("scope_kind","scope_id");
--> statement-breakpoint
WITH creator AS (
	SELECT "id"
	FROM "users"
	ORDER BY ("email" = 'danaasbury@gmail.com') DESC, "created_at" ASC, "id" ASC
	LIMIT 1
)
INSERT INTO "organizations" ("id", "slug", "name", "created_by")
SELECT 'org_' || substr(md5('goaugment:' || clock_timestamp()::text || ':' || random()::text), 1, 18), 'goaugment', 'GoAugment', "id"
FROM creator
ON CONFLICT ("slug") DO UPDATE SET "name" = excluded."name", "updated_at" = now();
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
), actor AS (
	SELECT "id"
	FROM "users"
	ORDER BY ("email" = 'danaasbury@gmail.com') DESC, "created_at" ASC, "id" ASC
	LIMIT 1
)
INSERT INTO "organization_members" ("org_id", "user_id", "role", "added_by")
SELECT org."id", users."id", CASE WHEN users."email" = 'danaasbury@gmail.com' OR (actor."id" = users."id" AND NOT EXISTS (SELECT 1 FROM "users" WHERE "email" = 'danaasbury@gmail.com')) THEN 'admin' ELSE 'member' END, actor."id"
FROM "users"
CROSS JOIN org
LEFT JOIN actor ON true
ON CONFLICT ("org_id", "user_id") DO UPDATE
SET "role" = CASE
	WHEN excluded."role" = 'admin' THEN 'admin'
	ELSE "organization_members"."role"
END,
"updated_at" = now();
--> statement-breakpoint
UPDATE "sessions"
SET "scope_kind" = 'user', "scope_id" = "user_id", "updated_at" = now()
WHERE "scope_kind" IS NULL OR "scope_id" IS NULL;
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
)
UPDATE "agent_library_items"
SET "scope_id" = org."id", "updated_at" = now()
FROM org
WHERE "agent_library_items"."scope_kind" = 'org'
  AND "agent_library_items"."scope_id" <> org."id";
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
)
UPDATE "automation_definitions"
SET "scope_kind" = 'user', "scope_id" = "owner_id", "updated_at" = now()
WHERE "scope_kind" <> 'user'
  AND "owner_kind" = 'user'
  AND "owner_id" IN (SELECT "id" FROM "users");
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
)
UPDATE "automation_definitions"
SET "scope_kind" = 'org', "scope_id" = org."id", "updated_at" = now()
FROM org
WHERE "automation_definitions"."scope_kind" NOT IN ('user', 'group', 'org');
--> statement-breakpoint
UPDATE "automation_events"
SET "scope_kind" = 'user', "scope_id" = sessions."user_id"
FROM "sessions"
WHERE "automation_events"."scope_kind" = 'session'
  AND "automation_events"."scope_id" = sessions."id";
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
)
UPDATE "automation_events"
SET "scope_kind" = 'org', "scope_id" = org."id"
FROM org
WHERE "automation_events"."scope_kind" NOT IN ('user', 'group', 'org');
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "scope_kind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "scope_id" SET NOT NULL;