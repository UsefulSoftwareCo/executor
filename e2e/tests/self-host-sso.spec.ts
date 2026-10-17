/** Operator SSO on self-host, against an issuer that keeps `email_verified` for its userinfo endpoint. */
import { expect, layer } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { startSelfHostSsoIdp, type SelfHostSsoMode } from "../support/self-host-sso.ts";
import { scenarios } from "../test-plan.ts";

const Session = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({ email: Schema.String, emailVerified: Schema.Boolean }),
  }),
);

layer(TestLive, { excludeTestServices: true })("Self-host SSO", (it) => {
  it.effect(scenarios.selfHostSsoUserinfo.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        // The provider checks the instance's origin on every return, so it must know it before
        // the instance starts and discovers the provider.
        const port = yield* freePort;
        const origin = `http://127.0.0.1:${port}`;
        const idp = yield* startSelfHostSsoIdp(origin);
        expect(
          yield* startFreshSelfHost(
            target,
            {
              SSO_DISCOVERY_URL: `${idp.origin}/.well-known/openid-configuration`,
              SSO_CLIENT_ID: "synthetic-sso-client",
              SSO_CLIENT_SECRET: "synthetic-sso-secret",
              SSO_ALLOWED_DOMAINS: "sso.example.test",
              NODE_EXTRA_CA_CERTS: idp.certificate,
            },
            port,
          ),
        ).toBe(origin);
        const owner = {
          name: "Synthetic Owner",
          email: "owner@example.test",
          password: "Synthetic-e2e-password-2026",
        };
        expect(
          yield* browser.use("Set up the instance", (page) =>
            page
              .context()
              .request.post(`${origin}/api/auth/self-host/setup`, {
                headers: { origin },
                data: { ...owner, organizationName: "Synthetic SSO" },
              })
              .then((response) => response.status()),
          ),
        ).toBe(200);
        const signOut = browser.use("Sign out", (page) =>
          page
            .context()
            .request.post(`${origin}/api/auth/sign-out`, { headers: { origin }, data: {} })
            .then((response) => response.status()),
        );
        const session = browser
          .use("Read the signed-in user", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
        const signIn = (email: string, mode: SelfHostSsoMode) =>
          Effect.gen(function* () {
            yield* idp.configure(email, mode);
            yield* browser.use(`Open sign-in for ${mode}`, (page) => page.goto(`${origin}/login`));
            yield* browser.use("Continue with SSO", (page) =>
              page.getByRole("button", { name: "Continue with SSO", exact: true }).click(),
            );
          });
        yield* signOut;
        // The ID token names the subject and email; only userinfo says the email is verified.
        const member = `thin-${randomUUID().slice(0, 8)}@sso.example.test`;
        yield* signIn(member, "userinfo-verified");
        yield* browser.use("The verified user reaches the dashboard", (page) =>
          page.waitForURL(/\/org\/[^/]+\/apps/),
        );
        yield* browser.checkpoint("SSO member admitted with email_verified from userinfo");
        const admitted = yield* session;
        expect(admitted?.user.email).toBe(member);
        expect(admitted?.user.emailVerified).toBe(true);
        yield* signOut;
        // The same thin ID token, when userinfo cannot vouch for the address: the instance
        // refuses to create the user at the callback, and no session exists.
        yield* signIn(
          `unverified-${randomUUID().slice(0, 8)}@sso.example.test`,
          "userinfo-unverified",
        );
        yield* browser.use("The callback refuses the unverified user", (page) =>
          page.waitForURL((url) => url.pathname === "/api/auth/callback/sso"),
        );
        expect(
          yield* browser.use("The refusal names the admission rule", (page) =>
            page.evaluate(() => document.body.innerText),
          ),
        ).toContain("Create the first account through setup, or use an invitation.");
        expect(yield* session).toBeNull();
        // And when userinfo describes another subject than the ID token named, the profile is
        // not this user's at all, so sign-in fails before any user exists.
        yield* signIn(
          `other-subject-${randomUUID().slice(0, 8)}@sso.example.test`,
          "userinfo-other-subject",
        );
        yield* browser.use("Sign-in fails for a foreign userinfo subject", (page) =>
          page.getByRole("alert").filter({ hasText: "SSO sign-in failed" }).waitFor(),
        );
        expect(yield* session).toBeNull();
        yield* browser.checkpoint(
          "SSO refused without a verified address for the signed-in subject",
        );
      }),
    ),
  );
});
