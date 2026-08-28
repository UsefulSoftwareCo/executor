CREATE TABLE "subject" (
	"external_id" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"last_seen_at" bigint,
	"status" text,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subject_uidx" ON "subject" USING btree ("tenant","external_id");