/** A loopback OIDC issuer exercises discovery, signatures, nonce binding and admission. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { betterAuth } from "better-auth";
import { ConfigProvider, Effect, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { selfHostDatabase } from "../src/database.ts";
import { AuthDatabase } from "../src/contracts/database.ts";
import { selfHostAuthOptions, selfHostAuthSettings } from "../src/implementation/auth-options.ts";
import { selfHostRegistration, selfHostUserHooks } from "../src/implementation/registration.ts";

test(
  "SSO admits verified allowed-domain users and rejects forgery, unverified email and removed members",
  { timeout: 60_000 },
  async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let issuer = "";
    let nonce = "";
    let email = "member@approved.test";
    let verified = true;
    let forged = false;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/discovery")
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      else if (request.url === "/jwks")
        response.end(
          JSON.stringify({
            keys: [
              {
                ...keys.publicKey.export({ format: "jwk" }),
                kid: "test",
                alg: "RS256",
                use: "sig",
              },
            ],
          }),
        );
      else if (request.url === "/token") {
        const encoded = (value: unknown) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const payload = `${encoded({ alg: "RS256", kid: "test" })}.${encoded({
          iss: issuer,
          aud: "sso-test",
          sub: email,
          email,
          email_verified: verified,
          name: "SSO member",
          nonce,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        })}`;
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(payload),
          forged ? attacker.privateKey : keys.privateKey,
        ).toString("base64url");
        response.end(
          JSON.stringify({
            access_token: "synthetic-access-token",
            token_type: "Bearer",
            expires_in: 300,
            id_token: `${payload}.${signature}`,
          }),
        );
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    issuer = `http://127.0.0.1:${address.port}`;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-sso-" });
            const origin = "http://localhost:55440";
            const config = ConfigProvider.fromUnknown({
              EXECUTOR_DATA_DIR: directory,
              BETTER_AUTH_URL: origin,
              BETTER_AUTH_SECRET: "synthetic-sso-signing-secret-1234567890",
            });
            yield* Effect.gen(function* () {
              const database = yield* AuthDatabase;
              const sql = yield* SqlClient.SqlClient;
              const baseSettings = yield* selfHostAuthSettings;
              // Only this loopback issuer uses HTTP. Production configuration requires HTTPS.
              const settings = {
                ...baseSettings,
                sso: {
                  discoveryUrl: `${issuer}/discovery`,
                  clientId: "sso-test",
                  clientSecret: Redacted.make("synthetic-client-secret"),
                  allowedDomains: ["approved.test"],
                },
              };
              const options = selfHostAuthOptions(settings, ["x-executor-client-ip"]);
              const auth = betterAuth({
                ...options,
                plugins: [...options.plugins, selfHostRegistration(settings)],
                databaseHooks: selfHostUserHooks(settings),
                database,
                secret: Redacted.value(settings.secret),
              });
              let client = 1;
              const request = (path: string, body?: unknown, cookie = "") =>
                Effect.promise(() =>
                  auth.handler(
                    new Request(`${origin}/api/auth${path}`, {
                      method: body === undefined ? "GET" : "POST",
                      headers: {
                        origin,
                        "content-type": "application/json",
                        cookie,
                        "x-executor-client-ip": `192.0.2.${client}`,
                      },
                      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    }),
                  ),
                );
              const login = () =>
                Effect.gen(function* () {
                  // Independent browser scenarios retain production rate limits without sharing an IP bucket.
                  client += 1;
                  const start = yield* request("/sign-in/social", {
                    provider: "sso",
                    callbackURL: "/apps",
                  });
                  assert.equal(start.status, 200);
                  const body = yield* Effect.promise(() => start.json()).pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String })),
                    ),
                  );
                  const url = new URL(body.url);
                  nonce = url.searchParams.get("nonce") ?? "";
                  assert.ok(nonce);
                  assert.ok(url.searchParams.get("code_challenge"));
                  const state = url.searchParams.get("state");
                  assert.ok(state);
                  const cookie = start.headers
                    .getSetCookie()
                    .map((value) => value.split(";")[0])
                    .join("; ");
                  return yield* request(
                    `/callback/sso?code=synthetic-code&state=${encodeURIComponent(state)}`,
                    undefined,
                    cookie,
                  );
                });
              const noSession = (response: Response) =>
                assert.ok(
                  !response.headers
                    .getSetCookie()
                    .some((cookie) => cookie.includes("session_token=")),
                );
              noSession(yield* login());
              assert.equal(
                (yield* sql`select id from "user"`).length,
                0,
                "SSO must not claim first-run ownership",
              );
              const setup = yield* request("/self-host/setup", {
                name: "Owner",
                email: "owner@example.test",
                password: "synthetic-owner-password",
                organizationName: "Example",
              });
              assert.equal(setup.status, 200);
              const signed = yield* login();
              assert.equal(signed.status, 302, yield* Effect.promise(() => signed.clone().text()));
              assert.equal(signed.headers.get("location"), "/apps");
              assert.ok(
                signed.headers.getSetCookie().some((cookie) => cookie.includes("session_token=")),
              );
              const member =
                yield* sql`select m.role from "member" m join "user" u on u.id = m."userId" where u.email = ${email}`;
              assert.equal(member[0]?.role, "member");
              yield* sql`delete from "member" where "userId" in (select id from "user" where email = ${email})`;
              noSession(yield* login());
              email = "unverified@approved.test";
              verified = false;
              noSession(yield* login());
              email = "outside@other.test";
              verified = true;
              noSession(yield* login());
              email = "forged@approved.test";
              forged = true;
              noSession(yield* login());
              assert.equal(
                (yield* sql`select id from "user"`).length,
                2,
                "rejected SSO identities must not create accounts",
              );
            }).pipe(
              Effect.provide(selfHostDatabase),
              Effect.provideService(ConfigProvider.ConfigProvider, config),
            );
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
