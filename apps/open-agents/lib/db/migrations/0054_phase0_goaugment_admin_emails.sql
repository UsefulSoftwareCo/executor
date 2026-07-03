WITH org AS (
	SELECT "id" FROM "organizations" WHERE "slug" = 'goaugment'
), actor AS (
	SELECT "id" FROM "users" WHERE "id" = 'open-agents-system'
), admin_users AS (
	SELECT "id" FROM "users" WHERE "email" IN ('danaasbury@gmail.com', 'dana.asbury@goaugment.com')
)
INSERT INTO "organization_members" ("org_id", "user_id", "role", "added_by")
SELECT org."id", admin_users."id", 'admin', actor."id"
FROM admin_users
CROSS JOIN org
LEFT JOIN actor ON true
ON CONFLICT ("org_id", "user_id") DO UPDATE SET
	"role" = CASE
		WHEN "organization_members"."role" = 'admin' OR excluded."role" = 'admin' THEN 'admin'
		ELSE "organization_members"."role"
	END,
	"updated_at" = now();
