/** Real Better Auth OTP, database migrations, and invitation delivery with a captured mail boundary. */
import type { NativeAuthUsage } from "../src/implementation/auth-analytics.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { betterAuth } from "better-auth";
import { HostedMigrationFailed, migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import {
  Config,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { selfHostDatabase } from "../../self-host/src/database.ts";
import { AuthDatabase } from "../../self-host/src/contracts/database.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../src/implementation/auth-options.ts";
import { EmailDeliveryFailed, type AuthEmail } from "../src/contracts/email.ts";
import { passkeyEnrollmentCookie } from "../src/contracts/passkey-enrollment.ts";

const origin = "https://cloud.example.test";
const baseConfig = {
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: "synthetic-cloud-auth-secret-1234567890",
  GOOGLE_CLIENT_ID: "google-fixture",
  GOOGLE_CLIENT_SECRET: "google-fixture-secret",
  GITHUB_CLIENT_ID: "github-fixture",
  GITHUB_CLIENT_SECRET: "github-fixture-secret",
};

const settingsWith = (extra: Record<string, string>) =>
  Effect.runPromise(
    Effect.exit(
      cloudAuthSettings.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ...baseConfig, ...extra }),
        ),
      ),
    ),
  );

test("auth migration rejects incompatible required columns before serving requests", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-auth-schema-" });
        yield* Effect.gen(function* () {
          const database = yield* AuthDatabase;
          const sql = yield* SqlClient.SqlClient;
          const settings = yield* cloudAuthSettings;
          const options = {
            ...cloudAuthOptions(settings, [], () => Effect.void),
            database,
            secret: baseConfig.BETTER_AUTH_SECRET,
          };
          yield* migrateHostedSchemas(options);
          yield* sql`alter table "user" add column "unexpected" text not null`;
          const result = yield* migrateHostedSchemas(options).pipe(Effect.result);
          assert.ok(Result.isFailure(result), "Migration must reject incompatible auth columns");
          assert.ok(Schema.is(HostedMigrationFailed)(result.failure));
          assert.equal(result.failure.stage, "auth");
          yield* sql`alter table "user" drop column "unexpected"`;
          yield* migrateHostedSchemas(options);
        }).pipe(
          Effect.provide(selfHostDatabase),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ...baseConfig, EXECUTOR_DATA_DIR: directory }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ));

test("test-stage proxy settings are all-or-nothing and extra trusted origins are parsed", async () => {
  const proxySecret = "synthetic-oauth-proxy-secret-1234567890";
  assert.ok(
    Exit.isFailure(await settingsWith({ OAUTH_PROXY_PRODUCTION_URL: "https://v2.example.test" })),
  );
  assert.ok(Exit.isFailure(await settingsWith({ OAUTH_PROXY_SECRET: proxySecret })));
  assert.ok(
    Exit.isFailure(
      await settingsWith({
        OAUTH_PROXY_PRODUCTION_URL: "https://v2.example.test/",
        OAUTH_PROXY_SECRET: proxySecret,
      }),
    ),
  );
  assert.ok(
    Exit.isFailure(
      await settingsWith({
        OAUTH_PROXY_PRODUCTION_URL: "https://v2.example.test",
        OAUTH_PROXY_SECRET: "too-short",
      }),
    ),
  );
  const none = await settingsWith({});
  assert.ok(
    Exit.isSuccess(none) &&
      Option.isNone(none.value.oauthProxy) &&
      none.value.trustedOrigins.length === 0,
  );
  const proxied = await settingsWith({
    OAUTH_PROXY_PRODUCTION_URL: "https://v2.example.test",
    OAUTH_PROXY_SECRET: proxySecret,
    AUTH_TRUSTED_ORIGINS: " https://*.executor.engineering , ,https://v2.example.test ",
  });
  assert.ok(Exit.isSuccess(proxied));
  const proxy = proxied.value.oauthProxy;
  assert.ok(Option.isSome(proxy));
  assert.equal(proxy.value.productionUrl, "https://v2.example.test");
  assert.equal(Redacted.value(proxy.value.secret), proxySecret);
  assert.deepEqual(proxied.value.trustedOrigins, [
    "https://*.executor.engineering",
    "https://v2.example.test",
  ]);
  const options = cloudAuthOptions(proxied.value, [], () => Effect.void);
  assert.ok(options.trustedOrigins.includes("https://*.executor.engineering"));
  assert.ok(options.plugins.some((plugin) => plugin.id === "oauth-proxy"));
});

test(
  "cloud codes verify email once, invitations send mail, and delivery failures are not success",
  { timeout: 60_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-cloud-auth-" });
          const config = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            ...baseConfig,
          });
          yield* Effect.gen(function* () {
            const database = yield* AuthDatabase;
            const sql = yield* SqlClient.SqlClient;
            const settings = yield* cloudAuthSettings;
            const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
            const messages: AuthEmail[] = [];
            const signups: string[] = [];
            const logins: string[] = [];
            const operations: NativeAuthUsage[] = [];
            let deliveryFails = false;
            const options = {
              ...cloudAuthOptions(
                settings,
                [],
                (email) =>
                  deliveryFails
                    ? Effect.fail(new EmailDeliveryFailed())
                    : Effect.sync(() => {
                        messages.push(email);
                      }),
                undefined,
                async (userId) => {
                  signups.push(userId);
                },
                async (userId) => {
                  logins.push(userId);
                },
                async (usage) => {
                  operations.push(usage);
                },
              ),
              database,
              secret: Redacted.value(secret),
            };
            yield* migrateHostedSchemas(options);
            const auth = betterAuth(options);
            const request = (path: string, body?: unknown, cookie = "") =>
              Effect.promise(() =>
                auth.handler(
                  new Request(`${origin}/api/auth${path}`, {
                    method: body === undefined ? "GET" : "POST",
                    headers: { origin, "content-type": "application/json", cookie },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                  }),
                ),
              );
            const email = "person@example.test";
            assert.equal(
              (yield* request("/email-otp/send-verification-otp", { email, type: "sign-in" }))
                .status,
              200,
            );
            assert.equal(messages.length, 1);
            const sent = messages[0];
            assert.ok(sent);
            const otp = Redacted.value(sent.text).match(/\b\d{6}\b/)?.[0];
            assert.ok(otp);
            assert.equal(sent.subject, "Your Executor sign-in code");
            assert.ok(!sent.subject.includes(otp));
            assert.ok(sent.html);
            for (const body of [Redacted.value(sent.text), Redacted.value(sent.html)]) {
              assert.ok(body.includes(otp));
              assert.ok(body.includes("expires in 5 minutes"));
              assert.ok(body.includes("Never share this code"));
            }
            const verification = yield* sql`select value from "verification"`;
            assert.ok(verification.every((row) => !String(row.value).includes(otp)));
            const signed = yield* request("/sign-in/email-otp", { email, otp });
            assert.equal(signed.status, 200, yield* Effect.promise(() => signed.clone().text()));
            const signedInUser = yield* Effect.promise(() => signed.clone().json()).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
                ),
              ),
            );
            assert.deepEqual(signups, [signedInUser.user.id]);
            const enrollment = signed.headers
              .getSetCookie()
              .find((value) => value.startsWith(`${passkeyEnrollmentCookie.name}=`));
            assert.ok(
              enrollment &&
                enrollment.startsWith(`${passkeyEnrollmentCookie.name}=${signedInUser.user.id};`),
            );
            assert.ok(
              enrollment.includes("Max-Age="),
              "New-account onboarding survives browser restarts",
            );
            assert.ok(
              !enrollment.includes("HttpOnly"),
              "The non-secret UI hint must be dismissible by the browser",
            );
            const user = yield* sql`select "emailVerified" from "user" where email = ${email}`;
            assert.equal(user[0]?.emailVerified, true);
            assert.notEqual((yield* request("/sign-in/email-otp", { email, otp })).status, 200);
            const cookie = signed.headers
              .getSetCookie()
              .map((value) => value.split(";")[0])
              .join("; ");
            const created = yield* request(
              "/organization/create",
              { name: "Example", slug: "example", keepCurrentActiveOrganization: true },
              cookie,
            );
            assert.equal(created.status, 200);
            const org = yield* Effect.promise(() => created.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))),
            );
            const invitation = yield* request(
              "/organization/invite-member",
              { organizationId: org.id, email: "invitee@example.test", role: "member" },
              cookie,
            );
            assert.equal(invitation.status, 200);
            assert.ok(
              operations.some(
                (usage) =>
                  usage.operation === "organization.invite-member" &&
                  usage.userId === signedInUser.user.id &&
                  usage.status === 200,
              ),
            );
            const beforePrivateRead = operations.length;
            yield* Effect.promise(() =>
              auth.api.listOrganizations({ headers: new Headers({ cookie }) }),
            );
            assert.equal(
              operations.length,
              beforePrivateRead,
              "Private auth calls must not require a request analytics context",
            );
            assert.equal(messages.length, 2);
            const inviteMail = messages[1];
            assert.ok(inviteMail);
            assert.ok(Redacted.value(inviteMail.text).includes(`${origin}/invite?invitation=`));
            const register = yield* request(
              "/passkey/generate-register-options",
              undefined,
              cookie,
            );
            assert.equal(
              register.status,
              200,
              yield* Effect.promise(() => register.clone().text()),
            );
            const ceremony = yield* Effect.promise(() => register.json()).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({ rp: Schema.Struct({ id: Schema.String }) }),
                ),
              ),
            );
            assert.equal(ceremony.rp.id, "cloud.example.test");
            deliveryFails = true;
            assert.ok(
              (yield* request("/email-otp/send-verification-otp", {
                email: "failure@example.test",
                type: "sign-in",
              })).status >= 400,
            );
            const retryInvite = {
              organizationId: org.id,
              email: "retry@example.test",
              role: "member",
              resend: true,
            };
            assert.ok(
              (yield* request("/organization/invite-member", retryInvite, cookie)).status >= 400,
            );
            const pending =
              yield* sql`select id from "invitation" where email = 'retry@example.test'`;
            assert.equal(pending.length, 1);
            deliveryFails = false;
            assert.equal(
              (yield* request("/organization/invite-member", retryInvite, cookie)).status,
              200,
            );
            const retried =
              yield* sql`select id from "invitation" where email = 'retry@example.test'`;
            assert.deepEqual(retried, pending);
            assert.equal(messages.length, 3);
            // Dismissing enrollment must not be undone by a later successful sign-in.
            assert.equal(
              (yield* request("/email-otp/send-verification-otp", { email, type: "sign-in" }))
                .status,
              200,
            );
            const nextCodeMessage = messages.at(-1);
            assert.ok(nextCodeMessage);
            const nextCode = Redacted.value(nextCodeMessage.text).match(/\b\d{6}\b/)?.[0];
            assert.ok(nextCode);
            const returning = yield* request("/sign-in/email-otp", { email, otp: nextCode });
            assert.equal(returning.status, 200);
            for (const response of [signed, returning]) {
              for (const name of ["executor_visitor", "executor_hero", "executor_hero_preview"]) {
                assert.ok(
                  response.headers
                    .getSetCookie()
                    .some((value) => value.startsWith(`${name}=`) && value.includes("Max-Age=0")),
                  "Every successful sign-in consumes anonymous attribution before another account can use it",
                );
              }
            }
            assert.deepEqual(logins, [signedInUser.user.id, signedInUser.user.id]);
            assert.deepEqual(
              signups,
              [signedInUser.user.id],
              "Returning sign-in is not another signup",
            );
            assert.ok(
              !returning.headers
                .getSetCookie()
                .some((value) => value.startsWith(`${passkeyEnrollmentCookie.name}=`)),
            );
          }).pipe(
            Effect.provide(selfHostDatabase),
            Effect.provideService(ConfigProvider.ConfigProvider, config),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ),
);
