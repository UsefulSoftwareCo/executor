CREATE TABLE IF NOT EXISTS "open_agents_executor_blob" (
	"namespace" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"id" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_connection" (
	"integration" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"template" text NOT NULL,
	"provider" text NOT NULL,
	"item_ids" json NOT NULL,
	"identity_label" text,
	"description" text,
	"tools_synced_at" bigint,
	"oauth_client" text,
	"oauth_client_owner" text,
	"refresh_item_id" text,
	"expires_at" bigint,
	"oauth_scope" text,
	"oauth_token_url" text,
	"provider_state" json,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_definition" (
	"integration" varchar(255) NOT NULL,
	"connection" varchar(255) NOT NULL,
	"plugin_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"schema" json NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_integration" (
	"slug" varchar(255) NOT NULL,
	"plugin_id" text NOT NULL,
	"name" text,
	"description" text,
	"config" json,
	"config_revised_at" bigint,
	"can_remove" boolean DEFAULT true NOT NULL,
	"can_refresh" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_oauth_client" (
	"slug" varchar(255) NOT NULL,
	"authorization_url" text NOT NULL,
	"token_url" text NOT NULL,
	"grant" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_item_id" text,
	"resource" text,
	"origin_kind" text,
	"origin_integration" text,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_oauth_session" (
	"state" varchar(255) NOT NULL,
	"client_slug" text NOT NULL,
	"integration" text NOT NULL,
	"name" text NOT NULL,
	"template" text NOT NULL,
	"redirect_url" text NOT NULL,
	"pkce_verifier" text,
	"identity_label" text,
	"payload" json NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_plugin_storage" (
	"plugin_id" varchar(255) NOT NULL,
	"collection" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"data" json NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "private_open_agents_executor_settings" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"version" varchar(255) DEFAULT '1.0.0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_tool" (
	"integration" varchar(255) NOT NULL,
	"connection" varchar(255) NOT NULL,
	"plugin_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"input_schema" json,
	"output_schema" json,
	"annotations" json,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_agents_executor_tool_policy" (
	"id" varchar(255) NOT NULL,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"position" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS "blob" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "chat_messages" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "connection" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "credential_binding" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "definition" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_operation" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_source" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_source_header" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "graphql_source_query_param" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_binding" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_source" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_source_header" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "mcp_source_query_param" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "oauth2_session" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_operation" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_header" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_query_param" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_spec_fetch_header" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "openapi_source_spec_fetch_query_param" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "secret" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "source" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tool" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tool_policy" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_blob_id_uidx" ON "open_agents_executor_blob" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_connection_uidx" ON "open_agents_executor_connection" USING btree ("tenant","owner","subject","integration","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_definition_uidx" ON "open_agents_executor_definition" USING btree ("tenant","owner","subject","integration","connection","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_integration_uidx" ON "open_agents_executor_integration" USING btree ("tenant","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_oauth_client_uidx" ON "open_agents_executor_oauth_client" USING btree ("tenant","owner","subject","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_oauth_session_uidx" ON "open_agents_executor_oauth_session" USING btree ("tenant","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_plugin_storage_uidx" ON "open_agents_executor_plugin_storage" USING btree ("tenant","owner","subject","plugin_id","collection","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_tool_uidx" ON "open_agents_executor_tool" USING btree ("tenant","owner","subject","integration","connection","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "open_agents_executor_tool_policy_uidx" ON "open_agents_executor_tool_policy" USING btree ("tenant","owner","subject","id");