CREATE TABLE "credential_delegation" (
	"id" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"credential_id" varchar(255) NOT NULL,
	"credential_kind" varchar(255) NOT NULL,
	"adapter" varchar(255) NOT NULL,
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"credential_subject" text NOT NULL,
	"credential_ref" varchar(255) NOT NULL,
	"issued_key_ref" varchar(255),
	"key_hash" varchar(255),
	"actor_subject" varchar(255) NOT NULL,
	"effective_subject" varchar(255) NOT NULL,
	"toolkit_membership" json NOT NULL,
	"scope" json NOT NULL,
	"scope_version" varchar(255) NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"revoke_reason" text,
	"created_at" timestamp NOT NULL,
	"last_used_at" bigint,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_audit" (
	"id" varchar(255) NOT NULL,
	"grant_id" varchar(255),
	"credential_id" varchar(255),
	"actor_subject" varchar(255) NOT NULL,
	"effective_subject" varchar(255) NOT NULL,
	"action" varchar(255) NOT NULL,
	"tool" text,
	"outcome" varchar(255) NOT NULL,
	"request_id" text,
	"execution_id" text,
	"occurred_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_challenge" (
	"id" varchar(255) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"credential_id" varchar(255),
	"credential_kind" varchar(255),
	"adapter" varchar(255) NOT NULL,
	"issuer" text,
	"audience" text,
	"credential_subject" text,
	"credential_ref" varchar(255),
	"actor_subject" varchar(255),
	"effective_subject" varchar(255) NOT NULL,
	"scope" json NOT NULL,
	"proof_hash" varchar(255) NOT NULL,
	"expires_at" bigint NOT NULL,
	"grant_expires_at" bigint NOT NULL,
	"proof_consumed_at" bigint,
	"consent_consumed_at" bigint,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credential_delegation_uidx" ON "credential_delegation" USING btree ("tenant","id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_delegation_binding_uidx" ON "credential_delegation" USING btree ("tenant","adapter","issuer","audience","credential_subject","credential_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_audit_uidx" ON "delegation_audit" USING btree ("tenant","id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_challenge_uidx" ON "delegation_challenge" USING btree ("tenant","id");