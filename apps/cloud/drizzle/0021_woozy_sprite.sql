CREATE TABLE "skill" (
	"id" varchar(255) NOT NULL,
	"name" varchar(255),
	"description" text,
	"active_revision_id" varchar(255) NOT NULL,
	"delivery" json NOT NULL,
	"source" json NOT NULL,
	"requirements" json,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_candidate" (
	"id" varchar(255) NOT NULL,
	"source" json NOT NULL,
	"package_digest" varchar(255) NOT NULL,
	"name" varchar(255),
	"description" text,
	"frontmatter" json,
	"files" json NOT NULL,
	"diagnostics" json NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_revision" (
	"id" varchar(255) NOT NULL,
	"skill_id" varchar(255) NOT NULL,
	"package_digest" varchar(255) NOT NULL,
	"name" varchar(255),
	"description" text,
	"frontmatter" json,
	"files" json NOT NULL,
	"diagnostics" json NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_uidx" ON "skill" USING btree ("tenant","owner","subject","id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_name_uidx" ON "skill" USING btree ("tenant","owner","subject","name");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_candidate_uidx" ON "skill_candidate" USING btree ("tenant","owner","subject","id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revision_uidx" ON "skill_revision" USING btree ("tenant","owner","subject","id");