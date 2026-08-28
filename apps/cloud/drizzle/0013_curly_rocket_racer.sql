CREATE TABLE "artifact" (
	"id" varchar(255) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"code" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_uidx" ON "artifact" USING btree ("tenant","owner","subject","id");