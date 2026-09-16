-- Backfill completeness per organization (`organizations.backfilled_at`: when
-- its membership list was last fully scanned from WorkOS), the organization
-- tombstone (`organizations.deleted_at`: kept by the local purge so a delayed
-- login cannot re-mint a deleted organization), the organization name stamp
-- (`organizations.workos_updated_at`: a name write stamped earlier is refused,
-- so a delayed login cannot revert a rename), and on the "events" row of
-- `workos_sync` the Events API replay boundary (`range_start`) the
-- reconciler's first run reads from plus the backfill completion mark
-- (`backfill_completed_at`) the authorization path checks before it trusts
-- the mirror over WorkOS. A database with no organizations has nothing to
-- backfill, so seed both there (fresh dev, test, and e2e databases); a
-- database that already holds organizations gets them from the backfill
-- script (scripts/backfill-workos-mirror.ts).
ALTER TABLE "organizations" ADD COLUMN "backfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "workos_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workos_sync" ADD COLUMN "range_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workos_sync" ADD COLUMN "backfill_completed_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "workos_sync" ("id", "cursor", "range_start", "backfill_completed_at", "updated_at")
SELECT 'events', NULL, now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "organizations");
