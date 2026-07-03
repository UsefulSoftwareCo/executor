ALTER TABLE "automation_message_queue" DROP COLUMN "started_workflow_run_id";--> statement-breakpoint
ALTER TABLE "automation_message_queue" ADD COLUMN "started_eve_session_id" text;
