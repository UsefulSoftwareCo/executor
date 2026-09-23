import { BlobStore, memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Deferred, Effect, Exit, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { selfHostDatabase } from "../../self-host/src/database.ts";
import { AuthDatabase } from "../../self-host/src/contracts/database.ts";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { cloudAuthOptions, cloudAuthSettings } from "../src/implementation/auth-options.ts";
import { migrateOnboarding } from "../src/implementation/migrations.ts";
import { makeOnboarding } from "../src/implementation/onboarding.ts";
import {
  CompanyLookup,
  CompanyLookupFailed,
  OnboardingDraft,
  OnboardingReady,
} from "../src/contracts/onboarding.ts";

test(
  "team confirmation is explicit, atomic, invitation-aware and collision-safe",
  { timeout: 30000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-onboarding-" });
          const config = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            BETTER_AUTH_URL: "https://cloud.example.test",
            BETTER_AUTH_SECRET: "synthetic-onboarding-secret-1234567890",
            GOOGLE_CLIENT_ID: "fixture",
            GOOGLE_CLIENT_SECRET: "fixture",
            GITHUB_CLIENT_ID: "fixture",
            GITHUB_CLIENT_SECRET: "fixture",
          });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const database = yield* AuthDatabase;
            const settings = yield* cloudAuthSettings;
            yield* migrateHostedSchemas({
              ...cloudAuthOptions(settings, [], () => Effect.void),
              database,
              secret: "synthetic-onboarding-secret-1234567890",
            });
            yield* migrateOnboarding;
            yield* migrateOnboarding;
            const requested: string[] = [];
            const cancelled = yield* Deferred.make<void>();
            let failing = true;
            const service = yield* makeOnboarding({ origin: "https://cloud.example.test" }).pipe(
              Effect.provideService(BlobStore, memoryBlobStore()),
              Effect.provideService(
                CompanyLookup,
                CompanyLookup.of({
                  lookup: (domain) =>
                    Effect.gen(function* () {
                      requested.push(domain);
                      if (domain === "slow.example")
                        return yield* Effect.never.pipe(
                          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
                        );
                      if (domain === "retry.example" && failing)
                        return yield* new CompanyLookupFailed();
                      if (domain === "gmail.com" || domain === "unmatched.example") return null;
                      return {
                        name: "Example Company",
                        website: `https://${domain}`,
                        description: null,
                        logo: "https://cdn.example.test/icon.png",
                        colors: [],
                      };
                    }),
                }),
              ),
            );
            const addUser = (id: string, email: string, verified = true) => sql`
        insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
        values (${id}, 'Ignored display name', ${email}, ${verified}, 'https://cdn.example.test/person.png', now(), now())`;
            yield* addUser("first", "first@company.example");
            const draft = yield* service.prepare("first");
            assert.ok(Schema.is(OnboardingDraft)(draft));
            assert.equal(draft.suggestion.name, "Example Company");
            assert.equal(draft.suggestion.logo, "https://cdn.example.test/icon.png");
            for (const name of ["organization", "member", "cloud_organization_setup"])
              assert.equal(
                (yield* sql`select * from ${sql(name)}`).length,
                0,
                "Suggestions do not provision",
              );
            assert.deepEqual(yield* service.prepare("first"), draft);
            assert.deepEqual(requested, ["company.example"], "Ready profiles are reused");
            const confirmed = { name: "Our Team", logo: null };
            const repeated = yield* Effect.all(
              Array.from({ length: 8 }, () => service.create("first", confirmed)),
              { concurrency: "unbounded" },
            );
            const firstResult = repeated[0];
            assert.ok(Schema.is(OnboardingReady)(firstResult));
            const first = firstResult.organizations[0];
            assert.ok(first);
            assert.ok(
              repeated.every(
                (result) =>
                  Schema.is(OnboardingReady)(result) && result.organizations[0]?.id === first.id,
              ),
            );
            assert.equal(first.name, "Our Team");
            assert.equal(first.logo, null);
            assert.equal(first.slug, "our-team");
            for (const name of ["organization", "member", "cloud_organization_setup"])
              assert.equal((yield* sql`select * from ${sql(name)}`).length, 1);
            assert.deepEqual(yield* service.prepare("first"), firstResult);
            assert.deepEqual(
              requested,
              ["company.example"],
              "No lookup or rename after confirmation",
            );

            yield* addUser("colleague", "colleague@company.example");
            const colleagueDraft = yield* service.prepare("colleague");
            assert.ok(Schema.is(OnboardingDraft)(colleagueDraft));
            const colleagueResult = yield* service.create("colleague", confirmed);
            assert.ok(Schema.is(OnboardingReady)(colleagueResult));
            const colleague = colleagueResult.organizations[0];
            assert.ok(
              colleague && colleague.id !== first.id,
              "Company domain never grants membership",
            );
            assert.match(colleague.slug, /^our-team-[a-f0-9]{6}$/);
            assert.equal(colleague.name, "Our Team", "Collision changes only the URL");
            yield* addUser("simultaneous-a", "a@gmail.com");
            yield* addUser("simultaneous-b", "b@gmail.com");
            const simultaneous = yield* Effect.all(
              ["simultaneous-a", "simultaneous-b"].map((id) =>
                service.create(id, { name: "Shared Team", logo: null }),
              ),
              { concurrency: "unbounded" },
            );
            const slugs = simultaneous.flatMap((result) =>
              Schema.is(OnboardingReady)(result) ? result.organizations.map((org) => org.slug) : [],
            );
            assert.equal(new Set(slugs).size, 2);
            assert.ok(slugs.includes("shared-team"));
            assert.ok(slugs.some((slug) => /^shared-team-[a-f0-9]{6}$/.test(slug)));

            yield* addUser("personal", "personal.fixture+fixture@gmail.com");
            const personal = yield* service.prepare("personal");
            assert.ok(Schema.is(OnboardingDraft)(personal));
            assert.equal(
              personal.suggestion.name,
              "Personal Fixture",
              "Fallback is derived from email",
            );
            yield* addUser("unmatched", "alex@unmatched.example");
            const unmatched = yield* service.prepare("unmatched");
            assert.ok(Schema.is(OnboardingDraft)(unmatched));
            assert.equal(unmatched.suggestion.name, "Alex");
            yield* addUser("private", "fixture@users.noreply.github.com");
            assert.ok(Schema.is(OnboardingDraft)(yield* service.prepare("private")));
            assert.ok(!requested.includes("users.noreply.github.com"));
            yield* addUser("slow", "slow@slow.example");
            const slow = yield* service.prepare("slow");
            assert.ok(Schema.is(OnboardingDraft)(slow));
            assert.equal(slow.suggestion.name, "Slow");
            assert.ok(
              yield* Deferred.isDone(cancelled),
              "The lookup is interrupted at its two-second deadline",
            );
            const slowCreated = yield* service.create("slow", { name: "Chosen Name", logo: null });
            assert.ok(Schema.is(OnboardingReady)(slowCreated));
            assert.equal(slowCreated.organizations[0]?.name, "Chosen Name");
            assert.deepEqual(yield* service.prepare("slow"), slowCreated);
            yield* addUser("retry", "retry@retry.example");
            const retry = yield* service.prepare("retry");
            assert.ok(Schema.is(OnboardingDraft)(retry));
            assert.equal(retry.suggestion.name, "Retry");
            failing = false;
            yield* sql`update cloud_company_profile set retry_at = now() - interval '1 second' where domain = 'retry.example'`;
            const retried = yield* service.prepare("retry");
            assert.ok(Schema.is(OnboardingDraft)(retried));
            assert.equal(retried.suggestion.name, "Example Company");

            yield* addUser("invited", "invited@company.example");
            yield* sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
        values ('invitation_fixture', ${first.id}, 'invited@company.example', 'member', 'pending', now() + interval '1 day', 'first')`;
            const invitation = { status: "invitation", invitation: "invitation_fixture" };
            assert.deepEqual(yield* service.prepare("invited"), invitation);
            assert.deepEqual(yield* service.create("invited", confirmed), invitation);
            yield* sql`update invitation set status = 'accepted' where id = 'invitation_fixture'`;
            assert.deepEqual(yield* service.create("invited", confirmed), {
              status: "ready",
              organizations: [],
            });
            yield* sql`delete from member where "userId" = 'colleague'`;
            assert.deepEqual(yield* service.prepare("colleague"), {
              status: "ready",
              organizations: [],
            });
            assert.deepEqual(yield* service.create("colleague", confirmed), {
              status: "ready",
              organizations: [],
            });
            yield* addUser("unverified", "unverified@company.example", false);
            assert.ok(Exit.isFailure(yield* Effect.exit(service.prepare("unverified"))));
            assert.ok(Exit.isFailure(yield* Effect.exit(service.create("unverified", confirmed))));
            assert.ok(
              Exit.isFailure(
                yield* Effect.exit(service.create("personal", { name: "   ", logo: null })),
              ),
            );

            yield* addUser("image-owner", "icon@example.test");
            const png = new Uint8Array(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
                "base64",
              ),
            );
            const withIcon = yield* service.create("image-owner", {
              name: "Image team",
              logo: { bytes: png },
            });
            assert.ok(Schema.is(OnboardingReady)(withIcon));
            const imageTeam = withIcon.organizations[0];
            assert.ok(imageTeam?.logo);
            const imageUrl = new URL(imageTeam.logo);
            const key = imageUrl.pathname.split("/").at(-1);
            assert.ok(key);
            assert.match(
              imageUrl.pathname,
              /^\/api\/onboarding\/icons\/image-owner\/[a-f0-9]{64}$/,
            );
            const stored = yield* service.icon("image-owner", "image-owner", key);
            assert.deepEqual(stored.bytes, png);
            assert.equal(stored.contentType, "image/png");
            assert.ok(
              Exit.isFailure(yield* Effect.exit(service.icon("first", "image-owner", key))),
            );
            // Referencing another team's private URL must not confer access to its bytes.
            yield* sql`update organization set logo = ${imageTeam.logo} where id = ${first.id}`;
            assert.ok(
              Exit.isFailure(yield* Effect.exit(service.icon("first", "image-owner", key))),
            );
            yield* sql`insert into member (id, "organizationId", "userId", role, "createdAt") values ('icon-member', ${imageTeam.id}, 'first', 'member', now())`;
            assert.deepEqual((yield* service.icon("first", "image-owner", key)).bytes, png);
            yield* sql`delete from member where id = 'icon-member'`;
            assert.ok(
              Exit.isFailure(yield* Effect.exit(service.icon("first", "image-owner", key))),
            );
            assert.ok(
              Exit.isFailure(
                yield* Effect.exit(
                  service.create("personal", {
                    name: "Invalid image",
                    logo: { bytes: new TextEncoder().encode("<svg onload='alert(1)'/>") },
                  }),
                ),
              ),
            );
            const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
            oversized.set(png);
            assert.ok(
              Exit.isFailure(
                yield* Effect.exit(
                  service.create("personal", {
                    name: "Oversize image",
                    logo: { bytes: oversized },
                  }),
                ),
              ),
            );
            yield* addUser("rollback", "rollback@gmail.com");
            const counts =
              yield* sql`select (select count(*) from organization) as organizations, (select count(*) from member) as members`;
            yield* sql`alter table cloud_organization_setup add constraint reject_fixture check (user_id <> 'rollback')`;
            assert.ok(
              Exit.isFailure(
                yield* Effect.exit(service.create("rollback", { name: "Rollback", logo: null })),
              ),
            );
            assert.deepEqual(
              yield* sql`select (select count(*) from organization) as organizations, (select count(*) from member) as members`,
              counts,
            );
            yield* sql`alter table cloud_organization_setup drop constraint reject_fixture`;
            assert.ok(
              Schema.is(OnboardingReady)(
                yield* service.create("rollback", { name: "Rollback", logo: null }),
              ),
            );
          }).pipe(
            Effect.provide(selfHostDatabase),
            Effect.provideService(ConfigProvider.ConfigProvider, config),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
);
