CREATE TABLE `oauth2_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`strategy` text NOT NULL,
	`connection_id` text NOT NULL,
	`token_scope` text NOT NULL,
	`redirect_url` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `oauth2_session_scope_id_idx` ON `oauth2_session` (`scope_id`);--> statement-breakpoint
CREATE INDEX `oauth2_session_plugin_id_idx` ON `oauth2_session` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `oauth2_session_connection_id_idx` ON `oauth2_session` (`connection_id`);--> statement-breakpoint
DROP TABLE `google_discovery_oauth_session`;--> statement-breakpoint
DROP TABLE `mcp_oauth_session`;--> statement-breakpoint
DROP TABLE `openapi_oauth_session`;--> statement-breakpoint
ALTER TABLE `graphql_source` ADD `query_params` text;--> statement-breakpoint
ALTER TABLE `graphql_source` ADD `auth` text;--> statement-breakpoint
ALTER TABLE `openapi_source` ADD `query_params` text;