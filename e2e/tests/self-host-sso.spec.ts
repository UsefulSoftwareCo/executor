import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import type { Page } from "playwright";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startControlledSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { selfHostSsoIdp, type IdentityMode } from "../support/sso.ts";
import { scenarios } from "../test-plan.ts";

const Session = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ email: Schema.String, emailVerified: Schema.Boolean }) }),
);

const startSsoInstance = (mode: IdentityMode) =>
  Effect.gen(function* () {
    const browser = yield* Browser,
      target = yield* Target;
    const instance = yield* startControlledSelfHost(target);
    const origin = instance.metadata.origin;
    const idp = yield* selfHostSsoIdp(origin);
    yield* idp.configure("member@sso.example.test", mode);
    yield* browser.use("Route the browser to the IdP's sign-in page", (page) =>
      page.context().route(
        (url) => url.origin === idp.issuer && url.pathname === "/authorize",
        (route) =>
          route.fulfill({
            status: 302,
            headers: { location: route.request().url().replace(idp.issuer, idp.origin) },
          }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* serverControl("stop");
      yield* serverControl("environment", 200, {
        SSO_DISCOVERY_URL: idp.discoveryUrl,
        SSO_CLIENT_ID: "synthetic-sso-client",
        SSO_CLIENT_SECRET: "synthetic-sso-secret",
        SSO_ALLOWED_DOMAINS: "sso.example.test",
        NODE_EXTRA_CA_CERTS: idp.certificate,
      });
      yield* serverControl("start");
    }).pipe(Effect.provideService(Target, instance));
    expect(
      yield* browser.use("Set up the instance", (page) =>
        page
          .context()
          .request.post(`${origin}/api/auth/self-host/setup`, {
            headers: { origin },
            data: {
              name: "Synthetic Owner",
              email: "owner@sso.example.test",
              password: "Synthetic-e2e-password-2026",
              organizationName: "Synthetic SSO",
            },
          })
          .then((response) => response.status()),
      ),
    ).toBe(200);
    return { idp, origin, log: `${instance.directory}/server.log` };
  });

const session = (origin: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser
      .use("Read the session", (page) =>
        page
          .context()
          .request.get(`${origin}/api/auth/get-session`)
          .then((response) => response.json()),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
  });

const continueWithSso = (origin: string, step: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(`${step}: sign out`, (page) => page.context().clearCookies());
    yield* browser.use(`${step}: open sign-in`, (page) => page.goto(`${origin}/login`));
    yield* browser.use(`${step}: continue with SSO`, (page) =>
      page.getByRole("button", { name: "Continue with SSO", exact: true }).click(),
    );
  });

const expectRejectedSignIn = (origin: string, step: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* continueWithSso(origin, step);
    yield* browser.use(`${step}: the rejected sign-in explains the failure`, (page) =>
      page.getByRole("alert").waitFor(),
    );
    expect(yield* session(origin)).toBeNull();
  });

const expectExplainedRejection = (origin: string, step: string, explanation: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* continueWithSso(origin, step);
    const alert = yield* browser.use(`${step}: read the explanation`, (page) =>
      page.getByRole("alert").textContent(),
    );
    expect(alert).toBe(explanation);
    expect(yield* session(origin)).toBeNull();
  });

const unverified =
  "Your identity provider did not confirm that this email address is verified. Ask your administrator to have the provider mark it verified.";

const expectUnavailableSso = (mode: IdentityMode, step: string, reason: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { origin, log } = yield* startSsoInstance(mode);
      yield* expectRejectedSignIn(origin, step);
      const output = yield* fs.readFileString(log);
      expect(output).toContain("SSO is unavailable: discovery at https://127.0.0.1:");
      expect(output).toContain(reason);
    }),
  );

layer(TestLive, { excludeTestServices: true })("Self-host SSO", (it) => {
  it.effect(scenarios.selfHostSsoDiscoveryRedirect.title, (context) =>
    withCase(
      context,
      expectUnavailableSso(
        "discovery-redirect",
        "Discovery redirected to cleartext",
        "redirected (HTTP 302)",
      ),
    ),
  );

  it.effect(scenarios.selfHostSsoCleartextSignIn.title, (context) =>
    withCase(
      context,
      expectUnavailableSso(
        "cleartext-authorization",
        "Cleartext sign-in page",
        "authorization_endpoint",
      ),
    ),
  );

  it.effect(scenarios.selfHostSsoCleartextTokenOrKeys.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        yield* expectUnavailableSso(
          "cleartext-token",
          "Cleartext token exchange",
          "token_endpoint",
        );
        yield* expectUnavailableSso("cleartext-jwks", "Cleartext signing keys", "jwks_uri");
      }),
    ),
  );

  it.effect(scenarios.selfHostSsoHttpsEndpoints.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { idp, origin } = yield* startSsoInstance("valid");
        yield* idp.configure("jwks-redirect@sso.example.test", "jwks-redirect");
        yield* expectRejectedSignIn(origin, "Signing keys redirected to cleartext");
        yield* idp.configure("token-redirect@sso.example.test", "token-redirect");
        yield* expectRejectedSignIn(origin, "Token exchange redirected to cleartext");
        yield* idp.configure("member@sso.example.test", "valid");
        yield* continueWithSso(origin, "HTTPS provider");
        yield* browser.use("The admitted member opens the organization", (page) =>
          page.waitForURL(`${origin}/org/*/**`),
        );
        expect(yield* session(origin)).toEqual({
          user: expect.objectContaining({ email: "member@sso.example.test", emailVerified: true }),
        });
      }),
    ),
  );

  it.effect(scenarios.selfHostSsoUserinfoClaims.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { idp, origin } = yield* startSsoInstance("valid");

        yield* idp.configure("other-subject@sso.example.test", "userinfo-other-subject");
        yield* expectExplainedRejection(origin, "UserInfo for another subject", unverified);
        yield* browser.checkpoint("SSO refused when UserInfo names another subject");

        yield* idp.configure("member@sso.example.test", "userinfo-verified");
        yield* continueWithSso(origin, "Email verified only at UserInfo");
        yield* browser.use("The member leaves sign-in", (page) =>
          page.waitForURL(
            (url) =>
              url.origin === origin &&
              !url.pathname.startsWith("/login") &&
              !url.pathname.startsWith("/api/"),
          ),
        );
        expect(yield* session(origin)).toEqual({
          user: expect.objectContaining({ email: "member@sso.example.test", emailVerified: true }),
        });
        yield* browser.checkpoint("SSO member admitted from UserInfo's email_verified");
      }),
    ),
  );

  it.effect(scenarios.selfHostSsoUnverifiedEmail.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { idp, origin } = yield* startSsoInstance("valid");
        yield* idp.configure("unverified@sso.example.test", "unverified");
        yield* expectExplainedRejection(origin, "Unverified everywhere", unverified);
        yield* idp.configure("unverified-thin@sso.example.test", "unverified-thin");
        yield* expectExplainedRejection(
          origin,
          "Thin ID token, unverified at UserInfo",
          unverified,
        );
        yield* idp.configure("unverified-absent@sso.example.test", "unverified-absent");
        yield* expectExplainedRejection(origin, "No verification claim", unverified);
      }),
    ),
  );

  it.effect(scenarios.selfHostSsoExistingAccountOrDomain.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { idp, origin } = yield* startSsoInstance("valid");
        yield* idp.configure("owner@sso.example.test", "valid");
        yield* expectExplainedRejection(
          origin,
          "Provider verifies a password account's address",
          "This email already has a password account on this instance. Sign in with your password, then connect SSO on your account's Security page.",
        );
        yield* idp.configure("member@outside.example.test", "valid");
        yield* expectExplainedRejection(
          origin,
          "Provider verifies an address outside the approved domains",
          "This email is not from a domain approved for SSO on this instance. Use an approved account or contact your administrator.",
        );
      }),
    ),
  );

  it.effect(scenarios.selfHostSsoConnectPasswordAccount.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { idp, origin } = yield* startSsoInstance("valid");
        const card = (page: Page) =>
          page.getByRole("heading", { name: "Single sign-on", exact: true });
        yield* browser.use("Open Security", (page) => page.goto(`${origin}/account/security`));
        yield* browser.use("Security offers to connect SSO", (page) => card(page).waitFor());
        yield* browser.checkpoint("Security offers to connect SSO");

        yield* idp.configure("member@sso.example.test", "valid");
        yield* browser.use("Connect another person's SSO account", (page) =>
          page.getByRole("button", { name: "Connect SSO", exact: true }).click(),
        );
        const refused = yield* browser.use("Read the refusal", (page) =>
          page
            .waitForURL(
              (url) => url.pathname === "/account/security" && url.searchParams.has("error"),
            )
            .then(() => page.getByRole("alert").textContent()),
        );
        expect(refused).toBe(
          "Your identity provider signed you in with a different email address. Connect the SSO account that uses this account's email.",
        );
        yield* browser.checkpoint("SSO for another email is refused with a reason");

        yield* idp.configure("owner@sso.example.test", "valid");
        yield* browser.use("Connect the owner's SSO account", (page) =>
          page.getByRole("button", { name: "Connect SSO", exact: true }).click(),
        );
        yield* browser.use("Security shows SSO connected", (page) =>
          page
            .waitForURL(
              (url) => url.pathname === "/account/security" && !url.searchParams.has("error"),
            )
            .then(() =>
              page
                .getByText("Connected. You can sign in with SSO or with your password.")
                .waitFor(),
            ),
        );
        yield* browser.checkpoint("SSO connected to the password owner");

        yield* continueWithSso(origin, "Owner signs in with connected SSO");
        yield* browser.use("The owner leaves sign-in", (page) =>
          page.waitForURL(
            (url) =>
              url.origin === origin &&
              !url.pathname.startsWith("/login") &&
              !url.pathname.startsWith("/api/"),
          ),
        );
        expect(yield* session(origin)).toEqual({
          user: expect.objectContaining({ email: "owner@sso.example.test", emailVerified: true }),
        });
      }),
    ),
  );
});
