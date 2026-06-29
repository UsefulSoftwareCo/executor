CREATE TABLE `openapi_source_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_scope_id` text NOT NULL,
	`target_scope_id` text NOT NULL,
	`slot` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `openapi_source_binding_source_id_idx` ON `openapi_source_binding` (`source_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_source_scope_id_idx` ON `openapi_source_binding` (`source_scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_target_scope_id_idx` ON `openapi_source_binding` (`target_scope_id`);--> statement-breakpoint
CREATE INDEX `openapi_source_binding_slot_idx` ON `openapi_source_binding` (`slot`);--> statement-breakpoint
ALTER TABLE `connection` DROP COLUMN `kind`;
