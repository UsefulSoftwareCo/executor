/** Production refuses proxied profiles and untrusted proxy redirect targets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { betterAuth } from "better-auth";
import { symmetricEncrypt } from "better-auth/crypto";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { Config, ConfigProvider, Effect, FileSystem, Redacted } from "effect";
import { selfHostDatabase } from "../../self-host/src/database.ts";
import { AuthDatabase } from "../../self-host/src/contracts/database.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../src/implementation/auth-options.ts";
import {
  isProxyStatePackage,
  proxyRedirectOrigins,
} from "../src/implementation/oauth-proxy-guard.ts";

const origin = "https://cloud.example.test";
const proxySecret = "synthetic-oauth-proxy-secret-1234567890";
const baseConfig = {
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: "synthetic-cloud-auth-secret-1234567890",
  GOOGLE_CLIENT_ID: "google-fixture",
  GOOGLE_CLIENT_SECRET: "google-fixture-secret",
  GITHUB_CLIENT_ID: "github-fixture",
  GITHUB_CLIENT_SECRET: "github-fixture-secret",
  OAUTH_PROXY_SECRET: proxySecret,
  AUTH_TRUSTED_ORIGINS: "https://*.executor.engineering",
};

const settingsFor = (productionUrl: string) =>
  cloudAuthSettings.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ...baseConfig, OAUTH_PROXY_PRODUCTION_URL: productionUrl }),
    ),
  );

/** What a stage's sign-in hook would place in the provider `state` parameter. */
const proxyState = async (
  callbackURL: string,
  options: { errorURL?: string; isOAuthProxy?: unknown } = {},
) => {
  const stateCookie = await symmetricEncrypt({
    key: proxySecret,
    data: JSON.stringify({
      callbackURL,
      codeVerifier: "verifier",
      errorURL: options.errorURL ?? `${callbackURL}/login`,
      oauthState: "bound-to-a-different-state",
    }),
  });
  return symmetricEncrypt({
    key: proxySecret,
    data: JSON.stringify({
      state: "attacker-state",
      stateCookie,
      isOAuthProxy: options.isOAuthProxy ?? true,
    }),
  });
};

test("the production guard is installed on production only; the location guard always", async () => {
  const production = cloudAuthOptions(
    await Effect.runPromise(settingsFor(origin)),
    [],
    () => Effect.void,
  );
  const ids = production.plugins.map((plugin) => plugin.id);
  assert.ok(ids.indexOf("executor-oauth-proxy-production-guard") < ids.indexOf("oauth-proxy"));
  // Better Auth runs after hooks in plugin order, so the location guard must run last.
  assert.ok(ids.indexOf("oauth-proxy") < ids.indexOf("executor-oauth-proxy-location-guard"));

  const stage = cloudAuthOptions(
    await Effect.runPromise(settingsFor("https://v2.example.test")),
    [],
    () => Effect.void,
  );
  const stageIds = stage.plugins.map((plugin) => plugin.id);
  assert.ok(stageIds.includes("oauth-proxy"));
  assert.ok(!stageIds.includes("executor-oauth-proxy-production-guard"));
  // The plugin rewrites `Location` on every host it runs on, so the guard follows it.
  assert.ok(
    stageIds.indexOf("oauth-proxy") < stageIds.indexOf("executor-oauth-proxy-location-guard"),
  );
});

test("production rejects proxy completion and untrusted proxy redirects", { timeout: 60_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-oauth-proxy-" });
        const config = ConfigProvider.fromUnknown({
          EXECUTOR_DATA_DIR: directory,
          ...baseConfig,
          OAUTH_PROXY_PRODUCTION_URL: origin,
        });
        yield* Effect.gen(function* () {
          const database = yield* AuthDatabase;
          const settings = yield* cloudAuthSettings;
          const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
          const options = {
            ...cloudAuthOptions(settings, [], () => Effect.void),
            database,
            secret: Redacted.value(secret),
          };
          yield* migrateHostedSchemas(options);
          const auth = betterAuth(options);
          const get = (path: string) =>
            Effect.promise(() =>
              auth.handler(new Request(`${origin}/api/auth${path}`, { redirect: "manual" })),
            );

          // A forged profile must never create a production session, even for its own origin.
          const completion = new URLSearchParams({ callbackURL: origin, profile: "forged" });
          for (const path of ["/callback/google/oauth-proxy", "/oauth-proxy-callback"]) {
            const response = yield* get(`${path}?${completion}`);
            assert.equal(response.status, 404, path);
            assert.ok(!response.headers.getSetCookie().some((c) => c.includes("session_token")));
          }

          // The code exchange must not send tokens to an origin outside the trusted list.
          const hostile = yield* get(
            `/callback/google?code=code&state=${encodeURIComponent(
              yield* Effect.promise(() =>
                proxyState("https://attacker.example.test/api/auth/callback/google/oauth-proxy"),
              ),
            )}`,
          );
          assert.equal(hostile.status, 403);
          assert.equal(hostile.headers.get("location"), null);

          // A package the plugin still accepts must not slip past a stricter guard check.
          const truthy = yield* get(
            `/callback/google?code=code&state=${encodeURIComponent(
              yield* Effect.promise(() =>
                proxyState("https://attacker.example.test/api/auth/callback/google/oauth-proxy", {
                  isOAuthProxy: 1,
                }),
              ),
            )}`,
          );
          assert.equal(truthy.status, 403);
          assert.equal(truthy.headers.get("location"), null);

          // errorURL is a redirect target on every failure branch, so it is checked too.
          const errorTarget = yield* get(
            `/callback/google?code=code&state=${encodeURIComponent(
              yield* Effect.promise(() =>
                proxyState(
                  "https://stage.executor.engineering/api/auth/callback/google/oauth-proxy",
                  { errorURL: "https://attacker.example.test/login" },
                ),
              ),
            )}`,
          );
          assert.equal(errorTarget.status, 403);
          assert.equal(errorTarget.headers.get("location"), null);

          // A trusted stage still reaches the proxy plugin, which then enforces state binding.
          const trusted = yield* get(
            `/callback/google?code=code&state=${encodeURIComponent(
              yield* Effect.promise(() =>
                proxyState(
                  "https://stage.executor.engineering/api/auth/callback/google/oauth-proxy",
                ),
              ),
            )}`,
          );
          assert.equal(trusted.status, 302);
          const location = trusted.headers.get("location") ?? "";
          assert.ok(location.startsWith("https://stage.executor.engineering/"), location);
          assert.ok(location.includes("state_mismatch"));
        }).pipe(
          Effect.provide(selfHostDatabase),
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  ),
);

test("a proxy package is recognised exactly as the plugin recognises it", () => {
  const base = { state: "s", stateCookie: "c" };
  assert.ok(isProxyStatePackage({ ...base, isOAuthProxy: true }));
  // The plugin uses a truthiness test, so a stricter check here would fail open.
  assert.ok(isProxyStatePackage({ ...base, isOAuthProxy: 1 }));
  assert.ok(isProxyStatePackage({ ...base, isOAuthProxy: "yes" }));
  assert.ok(!isProxyStatePackage({ ...base, isOAuthProxy: false }));
  assert.ok(!isProxyStatePackage({ ...base }));
  assert.ok(!isProxyStatePackage({ isOAuthProxy: true, state: "s" }));
  assert.ok(!isProxyStatePackage(null));
});

test("every redirect target in a proxy state is collected, not only callbackURL", () => {
  assert.deepEqual(proxyRedirectOrigins({ callbackURL: "https://stage.test/done" }), [
    "https://stage.test",
  ]);
  assert.deepEqual(
    proxyRedirectOrigins({
      callbackURL: "https://stage.test/done",
      errorURL: "https://evil.test/login",
      newUserURL: "https://other.test/welcome",
    }),
    ["https://stage.test", "https://evil.test", "https://other.test"],
  );
  // The receiving host finally redirects to the nested callbackURL.
  assert.deepEqual(
    proxyRedirectOrigins({
      callbackURL: "https://stage.test/done?callbackURL=https%3A%2F%2Fevil.test%2Fnext",
    }),
    ["https://stage.test", "https://evil.test"],
  );
  // A relative destination stays on the receiving host and contributes no origin.
  assert.deepEqual(
    proxyRedirectOrigins({ callbackURL: "https://stage.test/done?callbackURL=%2Fapps" }),
    ["https://stage.test"],
  );
});

test("an unusable proxy state is refused rather than waved through", () => {
  for (const state of [
    null,
    "not-an-object",
    {},
    { callbackURL: "" },
    { callbackURL: "https://stage.test", errorURL: 7 },
    { callbackURL: "https://stage.test", errorURL: "javascript:alert(1)" },
    { callbackURL: "https://stage.test?callbackURL=//evil.test" },
  ])
    assert.throws(() => proxyRedirectOrigins(state), /OAuth proxy/, JSON.stringify(state));
});
