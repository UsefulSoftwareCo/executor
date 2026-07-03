INSERT INTO "users" (
	"id",
	"username",
	"email_verified",
	"name",
	"is_admin",
	"created_at",
	"updated_at",
	"last_login_at"
)
VALUES (
	'open-agents-system',
	'open-agents-system',
	true,
	'Open Agents System',
	true,
	now(),
	now(),
	now()
)
ON CONFLICT ("id") DO UPDATE SET
	"username" = excluded."username",
	"email_verified" = true,
	"name" = excluded."name",
	"is_admin" = true,
	"updated_at" = now();
--> statement-breakpoint
INSERT INTO "organizations" ("id", "slug", "name", "created_by")
VALUES (
	'org_' || substr(md5('goaugment:' || clock_timestamp()::text || ':' || random()::text), 1, 18),
	'goaugment',
	'GoAugment',
	'open-agents-system'
)
ON CONFLICT ("slug") DO UPDATE SET
	"name" = excluded."name",
	"updated_at" = now();
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
), actor AS (
	SELECT "id" FROM "users" WHERE "id" = 'open-agents-system'
)
INSERT INTO "organization_members" ("org_id", "user_id", "role", "added_by")
SELECT
	org."id",
	users."id",
	CASE WHEN users."id" = 'open-agents-system' OR users."email" = 'danaasbury@gmail.com' THEN 'admin' ELSE 'member' END,
	actor."id"
FROM "users"
CROSS JOIN org
CROSS JOIN actor
ON CONFLICT ("org_id", "user_id") DO UPDATE SET
	"role" = CASE
		WHEN "organization_members"."role" = 'admin' OR excluded."role" = 'admin' THEN 'admin'
		ELSE 'member'
	END,
	"updated_at" = now();
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
SET "scope_kind" = 'org', "scope_id" = org."id", "updated_at" = now()
FROM org
WHERE "automation_definitions"."scope_kind" NOT IN ('user', 'group', 'org');
--> statement-breakpoint
WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
)
UPDATE "automation_events"
SET "scope_kind" = 'org', "scope_id" = org."id"
FROM org
WHERE "automation_events"."scope_kind" NOT IN ('user', 'group', 'org');