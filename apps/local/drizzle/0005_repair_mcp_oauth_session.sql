CREATE TABLE IF NOT EXISTS `mcp_oauth_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcp_oauth_session_scope_id_idx` ON `mcp_oauth_session` (`scope_id`);
