CREATE TABLE "skill" (
	"name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"frontmatter" json NOT NULL,
	"files" json NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_uidx" ON "skill" USING btree ("tenant","owner","subject","name");