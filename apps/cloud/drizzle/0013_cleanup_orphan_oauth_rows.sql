-- Remove stale OAuth rows left behind after connection cleanup.
--
-- Connection-owned Secret rows are hidden implementation details for a
-- Connection. If the owning Connection row no longer exists at the same scope,
-- the Secret row is unreachable and should not remain as dangling metadata.
-- Likewise, OAuth sessions for missing Connections cannot complete safely.

DELETE FROM "secret" s
WHERE s."owned_by_connection_id" IS NOT NULL
  AND NOT EXISTS (
		SELECT 1
		FROM "connection" c
		WHERE c."id" = s."owned_by_connection_id"
		  AND c."scope_id" = s."scope_id"
	);--> statement-breakpoint

DELETE FROM "oauth2_session" o
WHERE NOT EXISTS (
		SELECT 1
		FROM "connection" c
		WHERE c."id" = o."connection_id"
		  AND c."scope_id" = o."scope_id"
	);--> statement-breakpoint
