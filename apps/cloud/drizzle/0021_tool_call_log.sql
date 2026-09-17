CREATE TABLE "tool_call_log" (
	"id" varchar(255) NOT NULL,
	"address" text NOT NULL,
	"integration" varchar(255),
	"connection" varchar(255),
	"tool" text,
	"outcome" varchar(255) NOT NULL,
	"error_code" text,
	"error_message" text,
	"policy_action" text,
	"policy_pattern" text,
	"duration_ms" bigint NOT NULL,
	"arg_keys" json,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_log_uidx" ON "tool_call_log" USING btree ("tenant","owner","subject","id");