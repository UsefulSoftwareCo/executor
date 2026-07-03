CREATE TABLE "slack_thread_sessions" (
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"link_posted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_thread_sessions_slack_team_id_slack_channel_id_slack_thread_ts_pk" PRIMARY KEY("slack_team_id","slack_channel_id","slack_thread_ts")
);
--> statement-breakpoint
ALTER TABLE "slack_thread_sessions" ADD CONSTRAINT "slack_thread_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_sessions" ADD CONSTRAINT "slack_thread_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_sessions" ADD CONSTRAINT "slack_thread_sessions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_thread_sessions_user_idx" ON "slack_thread_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_sessions_chat_idx" ON "slack_thread_sessions" USING btree ("chat_id");