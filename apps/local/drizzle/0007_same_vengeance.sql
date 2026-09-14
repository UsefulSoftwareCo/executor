CREATE TABLE `skill` (
	`name` text NOT NULL,
	`description` text NOT NULL,
	`frontmatter` text NOT NULL,
	`files` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_uidx` ON `skill` (`tenant`,`owner`,`subject`,`name`);