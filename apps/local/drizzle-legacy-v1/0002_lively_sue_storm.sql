CREATE TABLE `connection` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`identity_label` text,
	`access_token_secret_id` text NOT NULL,
	`refresh_token_secret_id` text,
	`expires_at` integer,
	`scope` text,
	`provider_state` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `connection_scope_id_idx` ON `connection` (`scope_id`);--> statement-breakpoint
CREATE INDEX `connection_provider_idx` ON `connection` (`provider`);--> statement-breakpoint
ALTER TABLE `secret` ADD `owned_by_connection_id` text;--> statement-breakpoint
CREATE INDEX `secret_owned_by_connection_id_idx` ON `secret` (`owned_by_connection_id`);