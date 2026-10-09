CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `messages_created` ON `messages` (`created_at`);
