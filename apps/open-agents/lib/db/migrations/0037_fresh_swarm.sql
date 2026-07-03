CREATE TABLE "blob" (
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "blob_namespace_key_pk" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"provider" text NOT NULL,
	"identity_label" text,
	"access_token_secret_id" text NOT NULL,
	"refresh_token_secret_id" text,
	"expires_at" bigint,
	"scope" text,
	"provider_state" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "connection_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "credential_binding" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_scope_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"secret_id" text,
	"secret_scope_id" text,
	"connection_id" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "credential_binding_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "definition" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"schema" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "definition_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "graphql_operation" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	CONSTRAINT "graphql_operation_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "graphql_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"auth_connection_slot" text,
	CONSTRAINT "graphql_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "graphql_source_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "graphql_source_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "graphql_source_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "graphql_source_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_binding" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "mcp_binding_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"auth_header_name" text,
	"auth_header_slot" text,
	"auth_header_prefix" text,
	"auth_connection_slot" text,
	"auth_client_id_slot" text,
	"auth_client_secret_slot" text,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "mcp_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_source_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "mcp_source_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "mcp_source_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "mcp_source_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "oauth2_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"strategy" text NOT NULL,
	"connection_id" text NOT NULL,
	"token_scope" text NOT NULL,
	"redirect_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "oauth2_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_operation" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	CONSTRAINT "openapi_operation_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"spec" text NOT NULL,
	"source_url" text,
	"base_url" text,
	"oauth2" jsonb,
	CONSTRAINT "openapi_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_source_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "openapi_source_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_source_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "openapi_source_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_source_spec_fetch_header" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "openapi_source_spec_fetch_header_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "openapi_source_spec_fetch_query_param" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"slot_key" text,
	"prefix" text,
	CONSTRAINT "openapi_source_spec_fetch_query_param_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"owned_by_connection_id" text,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "secret_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"can_remove" boolean DEFAULT true NOT NULL,
	"can_refresh" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "tool" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "tool_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "tool_policy" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"position" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "tool_policy_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "connection_scope_id_idx" ON "connection" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "connection_provider_idx" ON "connection" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "credential_binding_scope_id_idx" ON "credential_binding" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "credential_binding_plugin_id_idx" ON "credential_binding" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "credential_binding_source_id_idx" ON "credential_binding" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "credential_binding_source_scope_id_idx" ON "credential_binding" USING btree ("source_scope_id");--> statement-breakpoint
CREATE INDEX "credential_binding_slot_key_idx" ON "credential_binding" USING btree ("slot_key");--> statement-breakpoint
CREATE INDEX "credential_binding_kind_idx" ON "credential_binding" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "credential_binding_secret_id_idx" ON "credential_binding" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "credential_binding_secret_scope_id_idx" ON "credential_binding" USING btree ("secret_scope_id");--> statement-breakpoint
CREATE INDEX "credential_binding_connection_id_idx" ON "credential_binding" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "definition_scope_id_idx" ON "definition" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "definition_source_id_idx" ON "definition" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "definition_plugin_id_idx" ON "definition" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "graphql_operation_scope_id_idx" ON "graphql_operation" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_operation_source_id_idx" ON "graphql_operation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "graphql_source_scope_id_idx" ON "graphql_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_source_header_scope_id_idx" ON "graphql_source_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_source_header_source_id_idx" ON "graphql_source_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "graphql_source_query_param_scope_id_idx" ON "graphql_source_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "graphql_source_query_param_source_id_idx" ON "graphql_source_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "mcp_binding_scope_id_idx" ON "mcp_binding" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_binding_source_id_idx" ON "mcp_binding" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "mcp_source_scope_id_idx" ON "mcp_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_header_scope_id_idx" ON "mcp_source_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_header_source_id_idx" ON "mcp_source_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "mcp_source_query_param_scope_id_idx" ON "mcp_source_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "mcp_source_query_param_source_id_idx" ON "mcp_source_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "oauth2_session_scope_id_idx" ON "oauth2_session" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "oauth2_session_plugin_id_idx" ON "oauth2_session" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "oauth2_session_connection_id_idx" ON "oauth2_session" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "openapi_operation_scope_id_idx" ON "openapi_operation" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_operation_source_id_idx" ON "openapi_operation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_scope_id_idx" ON "openapi_source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_header_scope_id_idx" ON "openapi_source_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_header_source_id_idx" ON "openapi_source_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_query_param_scope_id_idx" ON "openapi_source_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_query_param_source_id_idx" ON "openapi_source_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_header_scope_id_idx" ON "openapi_source_spec_fetch_header" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_header_source_id_idx" ON "openapi_source_spec_fetch_header" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_query_param_scope_id_idx" ON "openapi_source_spec_fetch_query_param" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "openapi_source_spec_fetch_query_param_source_id_idx" ON "openapi_source_spec_fetch_query_param" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "secret_scope_id_idx" ON "secret" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "secret_provider_idx" ON "secret" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "secret_owned_by_connection_id_idx" ON "secret" USING btree ("owned_by_connection_id");--> statement-breakpoint
CREATE INDEX "source_scope_id_idx" ON "source" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "source_plugin_id_idx" ON "source" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "tool_scope_id_idx" ON "tool" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "tool_source_id_idx" ON "tool" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "tool_plugin_id_idx" ON "tool" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "tool_policy_scope_id_position_idx" ON "tool_policy" USING btree ("scope_id","position");