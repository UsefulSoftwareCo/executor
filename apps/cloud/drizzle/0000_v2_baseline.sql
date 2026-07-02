CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_account_id_organization_id_pk" PRIMARY KEY("account_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob" (
	"namespace" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"id" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"integration" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"template" text NOT NULL,
	"provider" text NOT NULL,
	"item_ids" json NOT NULL,
	"identity_label" text,
	"oauth_client" text,
	"oauth_client_owner" text,
	"refresh_item_id" text,
	"expires_at" bigint,
	"oauth_scope" text,
	"provider_state" json,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "definition" (
	"integration" varchar(255) NOT NULL,
	"connection" varchar(255) NOT NULL,
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"schema" json NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration" (
	"slug" varchar(255) NOT NULL,
	"plugin_id" text NOT NULL,
	"description" text NOT NULL,
	"config" json,
	"can_remove" boolean DEFAULT true NOT NULL,
	"can_refresh" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"slug" varchar(255) NOT NULL,
	"authorization_url" text NOT NULL,
	"token_url" text NOT NULL,
	"grant" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_item_id" text,
	"resource" text,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_session" (
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
CREATE TABLE "plugin_storage" (
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
CREATE TABLE "private_executor_cloud_settings" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"version" varchar(255) DEFAULT '1.0.0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool" (
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
CREATE TABLE "tool_policy" (
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
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blob_id_uidx" ON "blob" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_uidx" ON "connection" USING btree ("tenant","owner","subject","integration","name");--> statement-breakpoint
CREATE UNIQUE INDEX "definition_uidx" ON "definition" USING btree ("tenant","owner","subject","integration","connection","name");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_uidx" ON "integration" USING btree ("tenant","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_uidx" ON "oauth_client" USING btree ("tenant","owner","subject","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_session_uidx" ON "oauth_session" USING btree ("tenant","state");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_storage_uidx" ON "plugin_storage" USING btree ("tenant","owner","subject","plugin_id","collection","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_uidx" ON "tool" USING btree ("tenant","owner","subject","integration","connection","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_policy_uidx" ON "tool_policy" USING btree ("tenant","owner","subject","id");