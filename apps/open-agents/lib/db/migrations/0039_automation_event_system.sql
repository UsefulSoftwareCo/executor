CREATE TABLE "automation_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"current_version_id" text,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition_json" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"change_summary" text
);
--> statement-breakpoint
CREATE TABLE "automation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_url" text,
	"repo_owner" text,
	"repo_name" text,
	"actor_json" jsonb,
	"trust" text DEFAULT 'internal' NOT NULL,
	"connector_id" text,
	"installation_id" text,
	"occurred_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"correlation_key" text,
	"payload_json" jsonb NOT NULL,
	"raw_payload_ref" text,
	"links_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "automation_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"automation_version_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"invocation_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"automation_version_id" text NOT NULL,
	"workflow_run_id" text,
	"session_id" text,
	"chat_id" text,
	"correlation_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"policy_snapshot_json" jsonb NOT NULL,
	"agent_snapshot_json" jsonb,
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_run_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"error_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "automation_state" (
	"automation_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"state_json" jsonb NOT NULL,
	"last_successful_run_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "automation_state_automation_id_scope_key_pk" PRIMARY KEY("automation_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "automation_correlations" (
	"automation_id" text NOT NULL,
	"correlation_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"session_id" text,
	"chat_id" text,
	"external_thread_id" text,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "automation_correlations_automation_id_correlation_key_pk" PRIMARY KEY("automation_id","correlation_key")
);
--> statement-breakpoint
CREATE TABLE "automation_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"schema_json" jsonb,
	"data_ref" text,
	"data_json" jsonb,
	"checksum" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"request_json" jsonb NOT NULL,
	"decision_json" jsonb,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text,
	"workflow_hook_token" text
);
--> statement-breakpoint
CREATE TABLE "automation_timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"visibility" text DEFAULT 'trace' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"destination" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_message_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"session_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_json" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"claimed_at" timestamp,
	"started_workflow_run_id" text,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_invocations" ADD CONSTRAINT "automation_invocations_event_id_automation_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."automation_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_invocations" ADD CONSTRAINT "automation_invocations_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_invocations" ADD CONSTRAINT "automation_invocations_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_invocation_id_automation_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."automation_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_attempts" ADD CONSTRAINT "automation_run_attempts_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_state" ADD CONSTRAINT "automation_state_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_correlations" ADD CONSTRAINT "automation_correlations_automation_id_automation_definitions_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_correlations" ADD CONSTRAINT "automation_correlations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_correlations" ADD CONSTRAINT "automation_correlations_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_artifacts" ADD CONSTRAINT "automation_artifacts_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_timeline_events" ADD CONSTRAINT "automation_timeline_events_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_outbox" ADD CONSTRAINT "automation_outbox_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_message_queue" ADD CONSTRAINT "automation_message_queue_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_message_queue" ADD CONSTRAINT "automation_message_queue_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_message_queue" ADD CONSTRAINT "automation_message_queue_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_message_queue" ADD CONSTRAINT "automation_message_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_definitions_scope_idx" ON "automation_definitions" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "automation_definitions_owner_idx" ON "automation_definitions" USING btree ("owner_kind","owner_id");--> statement-breakpoint
CREATE INDEX "automation_definitions_enabled_idx" ON "automation_definitions" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_automation_version_idx" ON "automation_versions" USING btree ("automation_id","version");--> statement-breakpoint
CREATE INDEX "automation_versions_automation_idx" ON "automation_versions" USING btree ("automation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_events_dedupe_idx" ON "automation_events" USING btree ("source","scope_kind","scope_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_events_route_idx" ON "automation_events" USING btree ("source","type","received_at");--> statement-breakpoint
CREATE INDEX "automation_events_subject_idx" ON "automation_events" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "automation_events_correlation_idx" ON "automation_events" USING btree ("correlation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_invocations_event_version_idx" ON "automation_invocations" USING btree ("event_id","automation_id","automation_version_id");--> statement-breakpoint
CREATE INDEX "automation_invocations_automation_idx" ON "automation_invocations" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_runs_invocation_idx" ON "automation_runs" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "automation_runs_status_idx" ON "automation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_runs_correlation_idx" ON "automation_runs" USING btree ("correlation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_attempts_run_number_idx" ON "automation_run_attempts" USING btree ("run_id","attempt_number");--> statement-breakpoint
CREATE INDEX "automation_state_scope_idx" ON "automation_state" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "automation_correlations_subject_idx" ON "automation_correlations" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "automation_correlations_session_idx" ON "automation_correlations" USING btree ("session_id","chat_id");--> statement-breakpoint
CREATE INDEX "automation_artifacts_run_idx" ON "automation_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_approvals_run_idx" ON "automation_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_approvals_status_idx" ON "automation_approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_timeline_events_run_idx" ON "automation_timeline_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_timeline_events_type_idx" ON "automation_timeline_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "automation_outbox_status_idx" ON "automation_outbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_outbox_run_idx" ON "automation_outbox" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_message_queue_chat_status_idx" ON "automation_message_queue" USING btree ("chat_id","status");--> statement-breakpoint
CREATE INDEX "automation_message_queue_run_idx" ON "automation_message_queue" USING btree ("run_id");
