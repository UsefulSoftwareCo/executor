CREATE TABLE `blob` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`namespace`, `key`)
);
--> statement-breakpoint
CREATE TABLE `definition` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`schema` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `definition_scope_id_idx` ON `definition` (`scope_id`);--> statement-breakpoint
CREATE INDEX `definition_source_id_idx` ON `definition` (`source_id`);--> statement-breakpoint
CREATE INDEX `definition_plugin_id_idx` ON `definition` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `google_discovery_binding` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_binding_scope_id_idx` ON `google_discovery_binding` (`scope_id`);--> statement-breakpoint
CREATE INDEX `google_discovery_binding_source_id_idx` ON `google_discovery_binding` (`source_id`);--> statement-breakpoint
CREATE TABLE `google_discovery_oauth_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_oauth_session_scope_id_idx` ON `google_discovery_oauth_session` (`scope_id`);--> statement-breakpoint
CREATE TABLE `google_discovery_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_source_scope_id_idx` ON `google_discovery_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `graphql_operation` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_operation_scope_id_idx` ON `graphql_operation` (`scope_id`);--> statement-breakpoint
CREATE INDEX `graphql_operation_source_id_idx` ON `graphql_operation` (`source_id`);--> statement-breakpoint
CREATE TABLE `graphql_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text NOT NULL,
	`headers` text,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_source_scope_id_idx` ON `graphql_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `mcp_binding` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_binding_scope_id_idx` ON `mcp_binding` (`scope_id`);--> statement-breakpoint
CREATE INDEX `mcp_binding_source_id_idx` ON `mcp_binding` (`source_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_session_scope_id_idx` ON `mcp_oauth_session` (`scope_id`);--> statement-breakpoint
CREATE TABLE `mcp_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_source_scope_id_idx` ON `mcp_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `openapi_oauth_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_oauth_session_scope_id_idx` ON `openapi_oauth_session` (`scope_id`);--> statement-breakpoint
CREATE TABLE `openapi_operation` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`binding` text NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_operation_scope_id_idx` ON `openapi_operation` (`scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_operation_source_id_idx` ON `openapi_operation` (`source_id`);--> statement-breakpoint
CREATE TABLE `openapi_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`base_url` text,
	`headers` text,
	`oauth2` text,
	`invocation_config` text NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `openapi_source_scope_id_idx` ON `openapi_source` (`scope_id`);--> statement-breakpoint
CREATE TABLE `secret` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `secret_scope_id_idx` ON `secret` (`scope_id`);--> statement-breakpoint
CREATE INDEX `secret_provider_idx` ON `secret` (`provider`);--> statement-breakpoint
CREATE TABLE `source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`can_remove` integer DEFAULT true NOT NULL,
	`can_refresh` integer DEFAULT false NOT NULL,
	`can_edit` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `source_scope_id_idx` ON `source` (`scope_id`);--> statement-breakpoint
CREATE INDEX `source_plugin_id_idx` ON `source` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `tool` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`source_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `tool_scope_id_idx` ON `tool` (`scope_id`);--> statement-breakpoint
CREATE INDEX `tool_source_id_idx` ON `tool` (`source_id`);--> statement-breakpoint
CREATE INDEX `tool_plugin_id_idx` ON `tool` (`plugin_id`);