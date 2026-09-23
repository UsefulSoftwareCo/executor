import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { HostedLive, withCase } from "../support/case.ts";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { ssoFixture } from "../support/sso.ts";
import { scenarios } from "../test-plan.ts";
import { holdQuery } from "../support/query-transition.ts";
import { Emulators } from "../support/emulators.ts";

const BillingOverview = Schema.Struct({
  enterprise: Schema.Boolean,
  plans: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      purchase: Schema.Literals(["checkout", "contact"]),
    }),
  ),
});

const enableEnterprise = (team: { readonly id: string; readonly slug: string }, capture = false) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser,
      emulators = yield* Emulators;
    const billingPath = `/api/organizations/${team.id}/billing`;
    const overview = yield* body(
      BillingOverview,
      yield* api.request(actors.owner, "GET", billingPath),
    );
    expect(overview.enterprise).toBe(false);
    const enterprise = overview.plans.find((plan) => plan.name === "Enterprise");
    if (!enterprise) return yield* Effect.die("Missing Enterprise from the provisioned catalog");
    expect(enterprise.purchase).toBe("contact");
    expect(
      (yield* api.request(actors.owner, "POST", `${billingPath}/checkout`, { plan: enterprise.id }))
        .status,
    ).toBe(400);
    if (capture) {
      for (const selection of [
        { name: "Free", status: "active" },
        { name: "Team", status: "active" },
        { name: "Enterprise", status: "scheduled" },
        { name: "Enterprise", status: "expired" },
      ] as const) {
        const plan = overview.plans.find((plan) => plan.name === selection.name);
        if (!plan) return yield* Effect.die("Missing required billing plan");
        yield* emulators.billingSubscription({
          organizationId: team.id,
          planId: plan.id,
          status: selection.status,
        });
        const current = yield* body(
          BillingOverview,
          yield* api.request(actors.owner, "GET", billingPath),
        );
        expect(current.enterprise).toBe(false);
        const held = yield* holdQuery(/\/api\/organizations\/[^/]+\/billing$/, "continue");
        yield* browser.use(`Open ${selection.name} settings before billing resolves`, (page) =>
          page.goto(`/org/${team.slug}/organization`),
        );
        yield* held.requested;
        expect(
          yield* browser.use("SSO stays hidden while the plan is unknown", (page) =>
            page.getByRole("heading", { name: "Single sign-on", exact: true }).count(),
          ),
        ).toBe(0);
        yield* held.release;
        yield* browser.use("Wait for the settings page to finish its reads", (page) =>
          page.waitForLoadState("networkidle"),
        );
        expect(
          yield* browser.use(`${selection.name} ${selection.status} hides SSO settings`, (page) =>
            page.getByRole("heading", { name: "Single sign-on", exact: true }).count(),
          ),
        ).toBe(0);
        if (selection.name === "Free")
          yield* browser.checkpoint("Free plan settings hide single sign-on");
        if (selection.name === "Team")
          yield* browser.checkpoint("Team plan settings hide single sign-on");
      }
      yield* browser.use("Open billing to inspect Enterprise purchase behavior", (page) =>
        page.goto(`/org/${team.slug}/billing`),
      );
      yield* browser.use("Enterprise uses contact sales", (page) =>
        page.getByRole("link", { name: "Contact sales", exact: true }).waitFor(),
      );
      yield* browser.checkpoint("Enterprise uses custom pricing and contact sales");
      const free = overview.plans.find((plan) => plan.name === "Free");
      if (!free) return yield* Effect.die("Missing Free from the provisioned catalog");
      yield* emulators.billingSubscription({
        organizationId: team.id,
        planId: `${free.id}-pay-as-you-go`,
        status: "active",
      });
      // Checkout synchronizes seats first. PAYG has no seats to synchronize and
      // must still reach the plan policy instead of failing with billing unavailable.
      expect(
        (yield* api.request(actors.owner, "POST", `${billingPath}/checkout`, {
          plan: enterprise.id,
        })).status,
      ).toBe(400);
    }
    yield* emulators.billingSubscription({
      organizationId: team.id,
      planId: enterprise.id,
      status: "active",
    });
    expect(
      (yield* body(BillingOverview, yield* api.request(actors.owner, "GET", billingPath)))
        .enterprise,
    ).toBe(true);
  }).pipe(Effect.provide(Emulators.layer));

const Connections = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      providerId: Schema.String,
      organizationId: Schema.String,
      domainVerified: Schema.Boolean,
      type: Schema.String,
    }),
  ),
});
const Team = Schema.Struct({ id: Schema.String, slug: Schema.String });
const Session = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String, emailVerified: Schema.Boolean }),
});
const browserSession = Effect.flatMap(Browser, (browser) =>
  browser.use("Read the actual signed-in user", (page) =>
    page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
  ),
).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
const signOut = Effect.flatMap(Browser, (browser) =>
  browser.use("Sign out of the product", (page) =>
    page.evaluate(() =>
      fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((response) => response.status),
    ),
  ),
);
const captureSignInThemes = (name: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Use the desktop viewport", (page) =>
      page.setViewportSize({ width: 1280, height: 800 }),
    );
    for (const colorScheme of ["light", "dark"] as const) {
      yield* browser.use(`Change the system appearance to ${colorScheme}`, (page) =>
        page.emulateMedia({ colorScheme }),
      );
      yield* browser.use("Let the controls finish their theme transition", (page) =>
        page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation instanceof CSSTransition)
              .map((animation) => animation.finished),
          ).then(() => undefined),
        ),
      );
      const colors = yield* browser.use("The sign-in surface follows the system theme", (page) =>
        page.getByRole("main").evaluate((main) => {
          const surface = getComputedStyle(main);
          const body = getComputedStyle(document.body);
          return {
            scheme: surface.colorScheme,
            background: surface.backgroundColor,
            foreground: surface.color,
            bodyBackground: body.backgroundColor,
            bodyForeground: body.color,
          };
        }),
      );
      expect(colors.scheme).toBe(colorScheme);
      expect(colors.background).toBe(colors.bodyBackground);
      expect(colors.foreground).toBe(colors.bodyForeground);
      yield* browser.checkpoint(`${name} in ${colorScheme} theme`);
      yield* browser.use("Use the phone viewport", (page) =>
        page.setViewportSize({ width: 390, height: 844 }),
      );
      yield* browser.checkpoint(`${name} in ${colorScheme} theme on mobile`);
      yield* browser.use("Restore the desktop viewport", (page) =>
        page.setViewportSize({ width: 1280, height: 800 }),
      );
    }
    yield* browser.use("Restore the light system appearance", (page) =>
      page.emulateMedia({ colorScheme: "light" }),
    );
  });
const submitSso = (buttonName: string, expectedStatus = 200) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const submit = browser.use("Start SSO", (page) =>
      Promise.all([
        page
          .waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/sso"))
          .then((response) => ({
            status: response.status(),
            retryAfter: response.headers()["x-retry-after"],
          })),
        page.getByRole("button", { name: buttonName, exact: true }).click(),
      ]).then(([response]) => response),
    );
    let response = yield* submit;
    if (response.status === 429) {
      // The scenario makes several real sign-ins. Honor the server's bounded
      // X-Retry-After without changing the product's authentication rate limit.
      const seconds = yield* Schema.decodeUnknownEffect(
        Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60)),
      )(Number(response.retryAfter));
      yield* Effect.sleep(seconds * 1000);
      response = yield* submit;
    }
    expect(response.status).toBe(expectedStatus);
  });
const start = (email: string, destination: string, capture = false) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Open sign-in with the exact return path", (page) =>
      page.goto(`/login?redirect=${encodeURIComponent(destination)}`),
    );
    yield* browser.use("Wait for sign-in choices", (page) =>
      page.getByRole("heading", { name: "Sign in", exact: true }).waitFor(),
    );
    if (capture) {
      yield* captureSignInThemes("Sign-in choices");
      yield* browser.use("Open sign-up from sign-in", (page) =>
        page.getByRole("link", { name: "Sign up", exact: true }).click(),
      );
      yield* browser.use("Account creation has its own heading", (page) =>
        page.getByRole("heading", { name: "Sign up", exact: true }).waitFor(),
      );
      expect(
        yield* browser.use("Sign-up preserves the destination", (page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("redirect")),
        ),
      ).toBe(destination);
      yield* browser.use("Return from sign-up", (page) =>
        page.getByRole("link", { name: "Sign in", exact: true }).click(),
      );
      yield* browser.use("Sign-in is restored", (page) =>
        page.getByRole("heading", { name: "Sign in", exact: true }).waitFor(),
      );
      expect(
        yield* browser.use("Returning from sign-up preserves the destination", (page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("redirect")),
        ),
      ).toBe(destination);
    }
    yield* browser.use("Open the direct SSO route", (page) =>
      page.goto(`/login/sso?redirect=${encodeURIComponent(destination)}`),
    );
    yield* browser.use("Open the separate SSO screen", (page) =>
      page.waitForURL((url) => url.pathname === "/login/sso"),
    );
    yield* browser.use("Wait for the SSO screen", (page) =>
      page.getByRole("heading", { name: "Sign in with SSO", exact: true }).waitFor(),
    );
    if (capture) {
      yield* browser.use("Reload the SSO document directly", (page) => page.reload());
      yield* browser.use("A direct load renders SSO", (page) =>
        page.getByRole("heading", { name: "Sign in with SSO", exact: true }).waitFor(),
      );
      expect(
        yield* browser.use("Keep the return path after reload", (page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("redirect")),
        ),
      ).toBe(destination);
      expect(
        yield* browser.use("The SSO screen has no social buttons or team-name field", (page) =>
          page.getByRole("button", { name: /Continue with Google|Continue with GitHub/ }).count(),
        ),
      ).toBe(0);
      expect(
        yield* browser.use("No team URL name is requested", (page) =>
          page.getByLabel("Team URL name", { exact: true }).count(),
        ),
      ).toBe(0);
      yield* browser.use("Go back to other sign-in methods", (page) =>
        page.getByRole("link", { name: "Back to sign in", exact: true }).click(),
      );
      yield* browser.use("The original login is restored", (page) =>
        page.getByRole("button", { name: "Continue with Google", exact: true }).waitFor(),
      );
      expect(
        yield* browser.use("Back navigation keeps the return path", (page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("redirect")),
        ),
      ).toBe(destination);
      yield* browser.use("Return to the direct SSO route", (page) =>
        page.goto(`/login/sso?redirect=${encodeURIComponent(destination)}`),
      );
      yield* browser.use("The work-email form is ready", (page) =>
        page.getByLabel("Work email", { exact: true }).waitFor(),
      );
      yield* captureSignInThemes("SSO sign-in");
    }
    yield* browser.use("Enter a work email without knowing a team name", (page) =>
      page.getByLabel("Work email", { exact: true }).fill(email),
    );
    if (capture) {
      yield* browser.checkpoint("SSO discovers the company from a work email");
      yield* browser.use("Show SSO on a narrow screen", (page) =>
        page.setViewportSize({ width: 390, height: 844 }),
      );
      yield* browser.checkpoint("SSO work-email sign-in on mobile");
      yield* browser.use("Restore the desktop viewport", (page) =>
        page.setViewportSize({ width: 1280, height: 800 }),
      );
      const held = yield* holdQuery(["/api/auth/sign-in/sso"], "fail", { method: "POST" });
      yield* browser.use("Start discovery during a network failure", (page) =>
        page.getByRole("button", { name: "Continue with SSO", exact: true }).click(),
      );
      yield* held.requested;
      expect(
        yield* browser.use("The email remains while discovery is pending", (page) =>
          page.getByLabel("Work email", { exact: true }).inputValue(),
        ),
      ).toBe(email);
      expect(
        yield* browser.use("Repeated submission is disabled", (page) =>
          page.getByRole("button", { name: "Continue with SSO", exact: true }).isDisabled(),
        ),
      ).toBe(true);
      yield* held.release;
      yield* browser.use("Explain the failed request", (page) =>
        page.getByRole("alert").filter({ hasText: "Cannot reach the server" }).waitFor(),
      );
      expect(
        yield* browser.use("Keep the work email for retry", (page) =>
          page.getByLabel("Work email", { exact: true }).inputValue(),
        ),
      ).toBe(email);
      yield* browser.checkpoint("SSO retains the work email after a network failure");
    }
    yield* submitSso("Continue with SSO");
  });

const openEmailSignIn = (email: string, destination: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const mailRequests = yield* browser.use("Observe email-code requests", (page) => {
      const methods: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/auth/email-otp/send-verification-otp")
          methods.push(request.method());
      });
      return Promise.resolve(methods);
    });
    yield* browser.use("Open the main email sign-in form", (page) =>
      page.goto(`/login?redirect=${encodeURIComponent(destination)}`),
    );
    yield* browser.use("Enter an email without choosing SSO", (page) =>
      page.getByLabel("Email", { exact: true }).fill(email),
    );
    return mailRequests;
  });

const startFromEmail = (email: string, destination: string, exerciseFailure = false) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const mailRequests = yield* openEmailSignIn(email, destination);
    if (exerciseFailure) {
      const held = yield* holdQuery(["/api/auth/sign-in/sso"], "fail", { method: "POST" });
      yield* browser.use("Detect SSO from the main email form", (page) =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      yield* held.requested;
      expect(
        yield* browser.use("The email remains while detection is pending", (page) =>
          page.getByLabel("Email", { exact: true }).inputValue(),
        ),
      ).toBe(email);
      expect(
        yield* browser.use("Repeated detection is disabled", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).isDisabled(),
        ),
      ).toBe(true);
      expect(mailRequests).toEqual([]);
      yield* held.release;
      yield* browser.use("Wait for the failed lookup's UI result", (page) =>
        page
          .getByRole("alert")
          .filter({ hasText: "Cannot reach the server" })
          .or(page.getByLabel("Sign-in code", { exact: true }))
          .waitFor(),
      );
      expect(
        yield* browser.use("The failed lookup keeps the email", (page) =>
          page.getByLabel("Email", { exact: true }).inputValue(),
        ),
      ).toBe(email);
      expect(
        yield* browser.use("A lookup failure does not fall back to an email code", (page) =>
          page.getByLabel("Sign-in code", { exact: true }).count(),
        ),
      ).toBe(0);
      expect(mailRequests).toEqual([]);
      yield* browser.checkpoint("Automatic SSO detection retains the email for retry");
    }
    yield* submitSso("Continue");
    expect(mailRequests).toEqual([]);
  });

const completed = (destination: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser,
      target = yield* Target;
    yield* browser.use("Wait for the protocol result", (page) =>
      page.waitForURL(
        (url) =>
          url.origin === target.metadata.origin &&
          (url.pathname === destination || url.searchParams.has("error")),
      ),
    );
    const outcome = yield* browser.use("Read the safe protocol result", (page) =>
      Promise.resolve({
        path: new URL(page.url()).pathname,
        error: new URL(page.url()).searchParams.get("error"),
      }),
    );
    expect(outcome).toEqual({ path: destination, error: null });
  });

layer(HostedLive, { excludeTestServices: true })("Cloud customer SSO", (it) => {
  it.effect(scenarios.cloudSsoOidc.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          fixture = yield* ssoFixture;
        const anonymous = yield* api.session();
        const authorizationTeam = actors.organization;
        const base = {
          organizationId: authorizationTeam.id,
          providerId: `sso-e2e-${randomUUID().slice(0, 12)}`,
          domain: "sso.example.test",
          issuer: fixture.origin,
          oidcConfig: {
            clientId: "synthetic-sso-client",
            clientSecret: "initial-synthetic-sso-secret",
            pkce: true,
          },
        };
        expect(
          (yield* api.request(actors.member, "POST", "/api/auth/sso/register", base)).status,
        ).toBe(403);
        expect((yield* api.request(anonymous, "POST", "/api/auth/sso/register", base)).status).toBe(
          401,
        );
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/sso/register", {
            ...base,
            issuer: "http://169.254.169.254",
          })).status,
        ).toBe(400);
        const publicRegistration = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/sso/register",
          { ...base, issuer: fixture.publicIssuer },
        );
        expect(publicRegistration.status).toBe(200);
        expect(JSON.stringify(publicRegistration.body)).not.toContain("synthetic-sso-secret");
        expect(
          (yield* api.request(anonymous, "POST", "/api/auth/sign-in/social", {
            provider: "google",
            callbackURL: fixture.publicIssuer,
          })).status,
        ).toBe(403);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/sso/delete-provider", {
              providerId: base.providerId,
            })
            .pipe(Effect.orDie),
        );
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name: "Synthetic OIDC Team",
          slug: `oidc-${randomUUID().slice(0, 8)}`,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status).toBe(200);
        const team = yield* body(Team, created);
        yield* browser.omitNetworkTrace;
        yield* browser.login(yield* freshOwnerSession);
        yield* enableEnterprise(team, true);
        yield* browser.use("Open team SSO settings", (page) =>
          page.goto(`/org/${team.slug}/organization`),
        );
        yield* browser.use("Add an OIDC connection", (page) =>
          page.getByRole("button", { name: "Add SSO connection", exact: true }).click(),
        );
        yield* browser.use("Fill the exact domain", (page) =>
          page.getByLabel("Email domain", { exact: true }).fill(base.domain),
        );
        yield* browser.use("Fill the issuer", (page) =>
          page.getByLabel("Issuer URL", { exact: true }).fill(fixture.origin),
        );
        yield* browser.use("Fill the client ID", (page) =>
          page.getByLabel("Client ID", { exact: true }).fill("synthetic-sso-client"),
        );
        yield* browser.use("Fill the write-only secret", (page) =>
          page.getByLabel("Client secret", { exact: true }).fill(base.oidcConfig.clientSecret),
        );
        yield* browser.use("Fail the first registration at the HTTP boundary", (page) =>
          page.route(
            "**/api/auth/sso/register",
            (route) =>
              route.fulfill({
                status: 503,
                contentType: "application/json",
                body: '{"message":"Unavailable"}',
              }),
            { times: 1 },
          ),
        );
        yield* browser.use("Save during the failure", (page) =>
          page.getByRole("button", { name: "Save connection", exact: true }).click(),
        );
        yield* browser.use("Show registration failure", (page) =>
          page.getByRole("alert").filter({ hasText: "The connection was not saved" }).waitFor(),
        );
        expect(
          yield* browser.use("Keep the form draft", (page) =>
            page.getByLabel("Issuer URL", { exact: true }).inputValue(),
          ),
        ).toBe(fixture.origin);
        yield* browser.checkpoint("SSO setup retains details for retry");
        const registered = yield* browser.use("Retry and inspect the public response", (page) =>
          Promise.all([
            page
              .waitForResponse((response) => response.url().endsWith("/api/auth/sso/register"))
              .then((response) => response.json()),
            page.getByRole("button", { name: "Save connection", exact: true }).click(),
          ]).then(([result]) => result),
        );
        expect(JSON.stringify(registered)).not.toContain("synthetic-sso-secret");
        const saved = yield* body(
          Connections,
          yield* api.request(actors.owner, "GET", "/api/auth/sso/providers"),
        );
        const connection = saved.providers.find((row) => row.organizationId === team.id);
        expect(connection).toBeDefined();
        if (!connection) return yield* Effect.die("Expected the registered connection");
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/sso/delete-provider", {
              providerId: connection.providerId,
            })
            .pipe(Effect.orDie),
        );
        expect(yield* fixture.storage(connection.providerId)).toEqual({
          verified: false,
          encrypted: true,
        });
        expect(
          (yield* api.request(anonymous, "POST", "/api/auth/sign-in/sso", {
            organizationSlug: team.slug,
            callbackURL: "/",
          })).status,
        ).toBe(401);
        expect(
          (yield* api.request(actors.member, "POST", "/api/auth/sso/update-provider", {
            providerId: connection.providerId,
            domain: "attacker.test",
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/sso/verify-domain", {
            providerId: connection.providerId,
          })).status,
        ).toBeGreaterThanOrEqual(400);
        expect((yield* fixture.storage(connection.providerId)).verified).toBe(false);
        expect(yield* fixture.storage(connection.providerId, true)).toEqual({
          verified: true,
          encrypted: true,
        });
        for (const email of ["nobody@unknown.example", "person@sub.sso.example.test"]) {
          const unavailable = yield* api.request(anonymous, "POST", "/api/auth/sign-in/sso", {
            email,
            callbackURL: "/",
          });
          expect(unavailable.status).toBe(404);
          expect(unavailable.body).toMatchObject({ code: "SSO_NOT_CONFIGURED" });
        }
        yield* browser.use("Reload verified settings", (page) => page.reload());
        yield* browser.use("The verified connection can be tested", (page) =>
          page.getByRole("button", { name: "Test sign-in", exact: true }).waitFor(),
        );
        yield* browser.use("Show the whole SSO settings card", (page) =>
          page
            .getByRole("heading", { name: "Single sign-on", exact: true })
            .scrollIntoViewIfNeeded(),
        );
        yield* browser.use("Bring the connection controls into view", (page) =>
          page
            .getByRole("button", { name: "Remove SSO connection", exact: true })
            .scrollIntoViewIfNeeded(),
        );
        yield* browser.checkpoint("Verified OIDC connection and credential rotation");
        yield* browser.use("Rotate the OIDC credential", (page) =>
          page.getByRole("button", { name: "Rotate client secret", exact: true }).click(),
        );
        yield* browser.use("Enter the replacement secret", (page) =>
          page.getByLabel("New client secret", { exact: true }).fill("synthetic-sso-secret"),
        );
        yield* browser.use("Save the new credential", (page) =>
          page.getByRole("button", { name: "Save credential", exact: true }).click(),
        );
        yield* browser.use("The completed update closes the form", (page) =>
          page.getByLabel("New client secret", { exact: true }).waitFor({ state: "hidden" }),
        );
        expect(yield* fixture.storage(connection.providerId)).toEqual({
          verified: true,
          encrypted: true,
        });
        yield* signOut;
        const email = `oidc-${randomUUID().slice(0, 8)}@sso.example.test`;
        yield* fixture.configure(email);
        const destination = `/org/${team.slug}/organization`;
        yield* start(email.toUpperCase(), destination, true);
        yield* completed(destination);
        const user = yield* browserSession;
        expect(user.user.email).toBe(email);
        expect(user.user.emailVerified).toBe(true);
        const members = yield* api.request(
          actors.owner,
          "GET",
          `/api/auth/organization/list-members?organizationId=${team.id}`,
        );
        const rows = yield* body(
          Schema.Struct({
            members: Schema.Array(
              Schema.Struct({ id: Schema.String, userId: Schema.String, role: Schema.String }),
            ),
          }),
          members,
        );
        expect(
          rows.members
            .filter((member) => member.userId === user.user.id)
            .map((member) => member.role),
        ).toEqual(["member"]);
        const member = rows.members.find((row) => row.userId === user.user.id);
        if (!member) return yield* Effect.die("Expected the SSO member");
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
            organizationId: team.id,
            memberId: member.id,
            role: "admin",
          })).status,
        ).toBe(200);
        yield* signOut;
        yield* startFromEmail(email.toUpperCase(), destination, true);
        yield* completed(destination);
        expect((yield* browserSession).user.id).toBe(user.user.id);
        const returning = yield* body(
          Schema.Struct({
            members: Schema.Array(Schema.Struct({ userId: Schema.String, role: Schema.String })),
          }),
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${team.id}`,
          ),
        );
        expect(
          returning.members.filter((row) => row.userId === user.user.id).map((row) => row.role),
        ).toEqual(["admin"]);
        yield* signOut;
        for (const mode of ["tamper", "wrong-audience"] as const) {
          yield* fixture.configure(email, mode);
          yield* start(email, destination);
          yield* browser.use("Invalid ID tokens return an error", (page) =>
            page.getByRole("alert").filter({ hasText: "Sign-in could not be completed" }).waitFor(),
          );
          expect(
            yield* browser.use("Invalid ID tokens create no session", (page) =>
              page.evaluate(() =>
                fetch("/api/auth/get-session").then((response) => response.json()),
              ),
            ),
          ).toBeNull();
        }
        yield* fixture.configure("outsider@another.example");
        yield* start(email, destination);
        yield* browser.use("A foreign email domain is rejected", (page) =>
          page.getByRole("alert").filter({ hasText: "Sign-in could not be completed" }).waitFor(),
        );
        expect(
          yield* browser.use("No session is issued for a foreign identity", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          ),
        ).toBeNull();
        expect((yield* fixture.storage(base.providerId, true)).verified).toBe(true);
        const ambiguous = yield* api.request(anonymous, "POST", "/api/auth/sign-in/sso", {
          email,
          callbackURL: "/",
        });
        expect(ambiguous.status).toBe(409);
        expect(ambiguous.body).toMatchObject({ code: "SSO_DOMAIN_AMBIGUOUS" });
        const ambiguousMailRequests = yield* openEmailSignIn(email, destination);
        yield* submitSso("Continue", 409);
        yield* browser.use("An ambiguous domain requires administrator help", (page) =>
          page.getByRole("alert").filter({ hasText: "More than one SSO connection" }).waitFor(),
        );
        expect(ambiguousMailRequests).toEqual([]);
        expect(
          yield* browser.use("Ambiguity does not request an email code", (page) =>
            page.getByLabel("Sign-in code", { exact: true }).count(),
          ),
        ).toBe(0);
      }),
    ),
  );

  it.effect(scenarios.cloudSsoSaml.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          fixture = yield* ssoFixture,
          target = yield* Target;
        const slug = `saml-${randomUUID().slice(0, 8)}`;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name: "Synthetic SAML Team",
          slug,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status).toBe(200);
        const team = yield* body(Team, created);
        yield* browser.omitNetworkTrace;
        yield* browser.login(yield* freshOwnerSession);
        yield* enableEnterprise(team);
        yield* browser.use("Open the SAML team's settings", (page) =>
          page.goto(`/org/${team.slug}/organization`),
        );
        yield* browser.use("Add a SAML connection", (page) =>
          page.getByRole("button", { name: "Add SSO connection", exact: true }).click(),
        );
        yield* browser.use("Choose SAML", (page) =>
          page.getByRole("button", { name: "SAML", exact: true }).click(),
        );
        yield* browser.use("Enter the SAML email domain", (page) =>
          page.getByLabel("Email domain", { exact: true }).fill("sso.example.test"),
        );
        const metadata = yield* fixture.metadata;
        yield* browser.use("Paste federation metadata", (page) =>
          page.getByLabel("Federation metadata XML", { exact: true }).fill(metadata),
        );
        const registered = yield* browser.use("Save the SAML connection", (page) =>
          Promise.all([
            page
              .waitForResponse((response) => response.url().endsWith("/api/auth/sso/register"))
              .then((response) => response.json()),
            page.getByRole("button", { name: "Save connection", exact: true }).click(),
          ]).then(([result]) => result),
        );
        const { providerId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ providerId: Schema.String }),
        )(registered);
        expect(yield* fixture.storage(providerId, true)).toEqual({
          verified: true,
          encrypted: true,
        });
        yield* browser.use("Reload the verified SAML connection", (page) => page.reload());
        yield* browser.use("Show the SAML connection", (page) =>
          page.getByRole("button", { name: "Test sign-in", exact: true }).scrollIntoViewIfNeeded(),
        );
        yield* browser.checkpoint("Verified SAML setup");
        yield* signOut;
        const email = `saml-${randomUUID().slice(0, 8)}@sso.example.test`;
        yield* fixture.configure(email);
        const destination = `/org/${team.slug}/organization`;
        yield* startFromEmail(email, destination);
        yield* browser.use("Submit the IdP's signed SAML response", (page) =>
          page.getByRole("button", { name: "Continue to Executor", exact: true }).click(),
        );
        yield* completed(destination);
        const identity = yield* browserSession;
        expect(identity.user.email).toBe(email);
        expect(identity.user.emailVerified).toBe(true);
        yield* browser.checkpoint("SAML member opens their team");
        yield* signOut;
        yield* browser.use("Replay the already consumed assertion", (page) =>
          page.goto(`${fixture.origin}/saml/replay`),
        );
        yield* browser.use("Submit the replay", (page) =>
          page.getByRole("button", { name: "Replay assertion", exact: true }).click(),
        );
        yield* browser.use("Replay returns an error", (page) =>
          page.waitForURL((url) => url.origin === target.metadata.origin),
        );
        expect(
          yield* browser.use("Replay creates no session", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          ),
        ).toBeNull();
        yield* fixture.configure(email, "tamper");
        yield* start(email, destination);
        yield* browser.use("Submit a changed signed assertion", (page) =>
          page.getByRole("button", { name: "Continue to Executor", exact: true }).click(),
        );
        yield* browser.use("Tampering returns to the product", (page) =>
          page.waitForURL((url) => url.origin === target.metadata.origin),
        );
        expect(
          yield* browser.use("Tampering creates no session", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          ),
        ).toBeNull();
        yield* fixture.configure(email);
        yield* start(email, destination);
        yield* browser.use("Remove the initiating browser's state", (page) =>
          page.context().clearCookies(),
        );
        const rejected = yield* browser.use(
          "Submit a valid assertion without its browser binding",
          (page) =>
            Promise.all([
              page
                .waitForResponse((response) => response.url().includes("/sso/saml2/sp/acs/"))
                .then((response) => response.status()),
              page.getByRole("button", { name: "Continue to Executor", exact: true }).click(),
            ]).then(([status]) => status),
        );
        expect(rejected).toBe(403);
        expect(
          yield* browser.use("An assertion from another browser creates no session", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          ),
        ).toBeNull();
      }),
    ),
  );
});
