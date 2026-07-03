CREATE TABLE "eve_chat_session_states" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eve_chat_events" (
	"chat_id" text NOT NULL,
	"stream_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "eve_chat_events_chat_id_stream_index_pk" PRIMARY KEY("chat_id","stream_index")
);
--> statement-breakpoint
ALTER TABLE "eve_chat_session_states" ADD CONSTRAINT "eve_chat_session_states_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eve_chat_events" ADD CONSTRAINT "eve_chat_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;
