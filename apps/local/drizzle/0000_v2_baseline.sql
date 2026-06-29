CREATE TABLE `blob` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blob_id_uidx` ON `blob` (`id`);--> statement-breakpoint
CREATE TABLE `connection` (
	`integration` text NOT NULL,
	`name` text NOT NULL,
	`template` text NOT NULL,
	`provider` text NOT NULL,
	`item_ids` text NOT NULL,
	`identity_label` text,
	`oauth_client` text,
	`oauth_client_owner` text,
	`refresh_item_id` text,
	`expires_at` blob,
	`oauth_scope` text,
	`provider_state` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_uidx` ON `connection` (`tenant`,`owner`,`subject`,`integration`,`name`);--> statement-breakpoint
CREATE TABLE `definition` (
	`integration` text NOT NULL,
	`connection` text NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`schema` text NOT NULL,
	`created_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `definition_uidx` ON `definition` (`tenant`,`owner`,`subject`,`integration`,`connection`,`name`);--> statement-breakpoint
CREATE TABLE `integration` (
	`slug` text NOT NULL,
	`plugin_id` text NOT NULL,
	`description` text NOT NULL,
	`config` text,
	`can_remove` integer DEFAULT 1 NOT NULL,
	`can_refresh` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_uidx` ON `integration` (`tenant`,`slug`);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`slug` text NOT NULL,
	`authorization_url` text NOT NULL,
	`token_url` text NOT NULL,
	`grant` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_item_id` text,
	`resource` text,
	`created_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_uidx` ON `oauth_client` (`tenant`,`owner`,`subject`,`slug`);--> statement-breakpoint
CREATE TABLE `oauth_session` (
	`state` text NOT NULL,
	`client_slug` text NOT NULL,
	`integration` text NOT NULL,
	`name` text NOT NULL,
	`template` text NOT NULL,
	`redirect_url` text NOT NULL,
	`pkce_verifier` text,
	`identity_label` text,
	`payload` text NOT NULL,
	`expires_at` blob NOT NULL,
	`created_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_session_uidx` ON `oauth_session` (`tenant`,`state`);--> statement-breakpoint
CREATE TABLE `plugin_storage` (
	`plugin_id` text NOT NULL,
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_storage_uidx` ON `plugin_storage` (`tenant`,`owner`,`subject`,`plugin_id`,`collection`,`key`);--> statement-breakpoint
CREATE TABLE `tool` (
	`integration` text NOT NULL,
	`connection` text NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`annotations` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_uidx` ON `tool` (`tenant`,`owner`,`subject`,`integration`,`connection`,`name`);--> statement-breakpoint
CREATE TABLE `tool_policy` (
	`id` text NOT NULL,
	`pattern` text NOT NULL,
	`action` text NOT NULL,
	`position` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_policy_uidx` ON `tool_policy` (`tenant`,`owner`,`subject`,`id`);
