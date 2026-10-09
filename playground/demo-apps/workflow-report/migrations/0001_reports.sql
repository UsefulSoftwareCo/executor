CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`open_issues` integer NOT NULL,
	`created_at` integer NOT NULL
);
