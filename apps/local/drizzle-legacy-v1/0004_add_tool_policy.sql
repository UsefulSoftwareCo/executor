CREATE TABLE `tool_policy` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`pattern` text NOT NULL,
	`action` text NOT NULL,
	-- Fractional-indexing key (Jira lexorank style). Lex-ordered text;
	-- always subdivisible by lengthening, so reorders never run out of
	-- room.
	`position` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
-- List queries are always `WHERE scope_id = ? ORDER BY position`, so the
-- composite index serves both the filter and the sort from one btree.
CREATE INDEX `tool_policy_scope_id_position_idx` ON `tool_policy` (`scope_id`, `position`);
