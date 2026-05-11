ALTER TABLE "credential_binding" ADD COLUMN "secret_scope_id" text;--> statement-breakpoint
CREATE INDEX "credential_binding_secret_scope_id_idx" ON "credential_binding" USING btree ("secret_scope_id");
