-- The membership mirror's backfill-complete marker (auth/workos-mirror-store.ts
-- `backfillCompletedAt`). The seat reporter refuses to push a member count to
-- billing until the one-off backfill (scripts/backfill-workos-mirror.ts) has
-- filled the mirror from WorkOS, because a count read before then is partial.
-- A database with no organizations has nothing to backfill, so seed the marker
-- there (fresh dev, test, and e2e databases); a database that already holds
-- organizations gets the marker only when the backfill script writes it.
INSERT INTO "workos_sync" ("id", "cursor", "updated_at")
SELECT 'backfill', NULL, now()
WHERE NOT EXISTS (SELECT 1 FROM "organizations");
