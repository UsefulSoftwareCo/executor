import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { expect } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Browser } from "./browser.ts";
import { holdOrganizationEntry } from "./organization-entry.ts";
import { Emulators } from "./emulators.ts";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";
import { targetHosts } from "./role-hosts.ts";

const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
);
const AuthFailure = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z_]{0,79}$/u)),
});
class OnboardingFailed extends Schema.TaggedError<OnboardingFailed>()("OnboardingFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `Onboarding check failed: ${this.operation}`;
  }
}
const make = Effect.gen(function* () {
  const browser = yield* Browser,
    emulators = yield* Emulators,
    evidence = yield* Evidence,
    target = yield* Target;
  const openLogin = Effect.gen(function* () {
    yield* browser.omitNetworkTrace;
    yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
  });
  const chooseSocial = (provider: "google" | "github") =>
    Effect.gen(function* () {
      const submit = browser.use(`Choose ${provider} sign-in`, (page) =>
        Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.origin === targetHosts(target).browser &&
              url.pathname === "/api/auth/sign-in/social"
            );
          }),
          page
            .getByRole("button", {
              name: provider === "google" ? "Continue with Google" : "Continue with GitHub",
              exact: true,
            })
            .click(),
        ]).then(([response]) =>
          (response.status() >= 400 &&
          response.headers()["content-type"]?.includes("application/json")
            ? response.json()
            : Promise.resolve(undefined)
          ).then((failure: unknown) => ({ status: response.status(), failure })),
        ),
      );
      const response = yield* submit;
      if (response.status !== 200) {
        const failure = Schema.decodeUnknownOption(AuthFailure)(response.failure);
        return yield* new OnboardingFailed({
          operation: `${provider} sign-in returned HTTP ${response.status}${failure._tag === "Some" ? ` (${failure.value.code})` : ""}`,
        });
      }
    });
  const organizations = browser
    .use("Read teams through the public session", (page) =>
      page.evaluate(() =>
        fetch("/api/auth/organization/list").then((response) => {
          if (response.status !== 200)
            throw new Error(`Team list returned HTTP ${response.status}`);
          return response.json();
        }),
      ),
    )
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Organizations)));
  const emailSignIn = (email: string, mode: "signin" | "signup" = "signin") =>
    Effect.gen(function* () {
      const flow = mode === "signup" ? "Sign up" : "Sign in";
      if (mode === "signup") {
        // New visitors start from the site's primary call to action, which opens sign-up.
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open the homepage", (page) => page.goto("/home"));
        yield* browser.use("Choose Get started", (page) =>
          page.getByRole("link", { name: "Get started", exact: true }).click(),
        );
        yield* browser.use("The sign-up view is ready", (page) =>
          page.getByRole("heading", { name: "Sign up", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Sign up with email or a social account");
        // The address has an @ but no domain the server accepts; the error names the address.
        yield* browser.use("Enter an email without a domain", (page) =>
          page.getByLabel("Email", { exact: true }).fill("new-user@example"),
        );
        yield* browser.use("Submit the incomplete email", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the email error", (page) =>
            page.getByRole("alert").filter({ hasText: "email" }).innerText(),
          ),
        ).toBe("Enter a valid email address, such as name@example.com.");
        yield* browser.checkpoint("Sign-up rejects an incomplete email");
      } else yield* openLogin;
      yield* browser.use("Enter the synthetic email", (page) =>
        page.getByLabel("Email", { exact: true }).fill(email),
      );
      const received = yield* emulators.received(email);
      yield* browser.use("Request a real sign-in code", (page) =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      const delivered = yield* evidence.step(
        "Read the delivered code from the mail emulator",
        emulators.mail(email, received),
      );
      // A first code creates the account, so its email says sign-up whichever view sent it.
      if (mode === "signup") expect(delivered.subject).toBe("Your Executor sign-up code");
      yield* browser.use("Enter the delivered code", (page) =>
        page
          .getByLabel(mode === "signup" ? "Sign-up code" : "Sign-in code", { exact: true })
          .fill(Redacted.value(delivered.code)),
      );
      yield* browser.use("Verify the code", (page) =>
        page.getByRole("button", { name: flow, exact: true }).click(),
      );
      yield* browser.use("Sign-in advances to enrollment or the destination", (page) =>
        page.waitForFunction(
          (origin) =>
            window.location.origin === origin &&
            (window.location.pathname !== "/login" ||
              document.querySelector("h1")?.textContent === "Create a passkey"),
          targetHosts(target).browser,
        ),
      );
    });
  return {
    chooseSocial,
    organizations,
    emailSignIn,
    freshEmail: Effect.sync(() => `onboarding-${randomUUID()}@example.test`),
    socialSignIn: (provider: "google" | "github") =>
      Effect.gen(function* () {
        const identity = yield* evidence.step(
          `Seed a fresh ${provider} identity through emulators.dev`,
          emulators.identity(provider),
        );
        yield* openLogin;
        const memberships = yield* holdOrganizationEntry;
        yield* chooseSocial(provider);
        const document = yield* browser.use(
          `Choose the identity on the ${provider} emulator`,
          (page) =>
            Promise.all([
              // The Worker resolves sign-in and opens team setup directly, rendered on the server.
              page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().isNavigationRequest() &&
                  url.origin === targetHosts(target).browser &&
                  url.pathname === "/create"
                );
              }),
              page.getByRole("button").filter({ hasText: identity.email }).click(),
            ]).then(([response]) =>
              response.text().then((html) => ({
                status: response.status(),
                prepared: html.includes("Create your team") && html.includes("cloud:entry-team:"),
                private: response.headers()["cache-control"]?.includes("no-store") === true,
              })),
            ),
        );
        if (document.status !== 200)
          return yield* new OnboardingFailed({ operation: "Sign-in document did not load" });
        yield* evidence.json("entry-document-check.json", document);
        if (!document.prepared || !document.private)
          return yield* new OnboardingFailed({
            operation: "Sign-in document must contain private server-prepared team setup",
          });
        yield* browser.use("Team form renders without a browser membership read", (page) =>
          page
            .getByRole("heading", { name: "Create your team", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* memberships.release;
        yield* browser.use("Complete the OAuth callback into Cloud", (page) =>
          page.waitForURL(
            (url) => url.origin === targetHosts(target).browser && url.pathname !== "/login",
          ),
        );
        yield* evidence.json("identity-provider.json", {
          provider,
          emulated: true,
          sessionInjected: false,
        });
        return identity;
      }),
    /** Sign in with Google as an address that already has an Executor account. */
    googleSignInAs: (user: {
      readonly email: string;
      readonly name: string;
      readonly picture: string;
    }) =>
      Effect.gen(function* () {
        yield* evidence.step(
          "Seed a Google profile for the existing email through emulators.dev",
          emulators.googleUser(user),
        );
        yield* openLogin;
        yield* chooseSocial("google");
        yield* browser.use("Choose the identity on the google emulator", (page) =>
          page.getByRole("button").filter({ hasText: user.email }).click(),
        );
      }),
    delayPreparation: Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        completed = yield* Deferred.make<void, OnboardingFailed>();
      let started = false;
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(() =>
            started ? Deferred.await(completed).pipe(Effect.ignore) : Effect.void,
          ),
        ),
      );
      yield* browser.use("Hold one team preparation request at the network boundary", (page) =>
        page.route(
          "**/api/onboarding/prepare",
          (route) =>
            // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Playwright route handlers must return a Promise
            Effect.runPromise(
              Effect.gen(function* () {
                started = true;
                yield* Deferred.succeed(arrived, undefined);
                yield* Deferred.await(release).pipe(Effect.timeout("60 seconds"));
                yield* driver("Send the original preparation request", () => route.continue());
              }).pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Deferred.fail(
                      completed,
                      new OnboardingFailed({
                        operation: "Continue the delayed preparation request",
                      }),
                    ),
                  onSuccess: () => Deferred.succeed(completed, undefined),
                }),
              ),
            ),
          { times: 1 },
        ),
      );
      return {
        wasRequested: Effect.sync(() => started),
        show: Effect.gen(function* () {
          yield* browser.use("The server prepared the form before its first render", (page) =>
            page.getByLabel("Team name", { exact: true }).waitFor({ state: "visible" }),
          );
          if (started)
            return yield* new OnboardingFailed({
              operation: "Setup repeated preparation in the browser",
            });
          const spinners = yield* browser.use(
            "No intermediate sign-in or preparation view is mounted",
            (page) => page.locator('.auth-pending, [aria-label="Preparing your team"]').count(),
          );
          if (spinners !== 0)
            return yield* new OnboardingFailed({
              operation: "Unexpected intermediate setup loading view",
            });
          yield* browser.checkpoint("Team form ready on first entry");
          yield* evidence.json("preparation-delay.json", {
            browserPreparationRequested: started,
            serverPrepared: true,
            responseReplaced: false,
          });
          yield* Deferred.succeed(release, undefined);
          if (started) yield* Deferred.await(completed);
        }),
        release: Deferred.succeed(release, undefined),
      };
    }),
    prepareTeam: Effect.gen(function* () {
      yield* browser.use("Team details are ready to review", (page) =>
        page.getByLabel("Team name", { exact: true }).waitFor({ state: "visible" }),
      );
      const entry = yield* browser.use("Setup stays outside the dashboard", (page) =>
        page
          .locator(".shell")
          .count()
          .then((shells) => ({ pathname: new URL(page.url()).pathname, shells })),
      );
      if (entry.pathname !== "/create" || entry.shells !== 0)
        return yield* new OnboardingFailed({
          operation: "Expected shell-free team confirmation at /create",
        });
      const suggested = yield* browser.use("Read the suggested team name", (page) =>
        page.getByLabel("Team name", { exact: true }).inputValue(),
      );
      if (!suggested.trim())
        return yield* new OnboardingFailed({ operation: "Missing team suggestion" });
      const name = `Onboarding ${randomUUID().slice(0, 8)}`;
      yield* browser.use("Edit the suggested team name", (page) =>
        page.getByLabel("Team name", { exact: true }).fill(name),
      );
      yield* browser.checkpoint("Review team details before creation");
      return name;
    }),
    suggestedTeamName: browser.use("Read the company suggestion from the real response", (page) =>
      page.getByLabel("Team name", { exact: true }).inputValue(),
    ),
    failConfirmationOnce: browser.use(
      "Interrupt one confirmation request before sending it",
      (page) =>
        page.route("**/api/onboarding/create", (route) => route.abort("failed"), { times: 1 }),
    ),
    confirmTeam: (name: string) =>
      Effect.gen(function* () {
        yield* browser.use("Confirm team creation", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Team creation opens agent setup", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/create/agent`),
        );
        const teams = yield* organizations;
        if (teams.length !== 1 || teams[0]?.name !== name)
          return yield* new OnboardingFailed({
            operation: "Confirmation must create exactly the chosen team",
          });
        yield* browser.use("The MCP handoff is visible", (page) =>
          page.getByRole("heading", { name: "Continue in your agent", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Continue in your agent after team creation");
        yield* browser.use("Reload the MCP handoff", (page) => page.reload());
        yield* browser.use("Reload keeps the agent instructions open", (page) =>
          page.getByRole("heading", { name: "Continue in your agent", exact: true }).waitFor(),
        );
        const endpoint = `${targetHosts(target).mcp}/mcp`;
        yield* browser.use("The public MCP URL is visible", (page) =>
          page.getByText(endpoint, { exact: true }).waitFor(),
        );
        yield* browser.use("Allow clipboard access in the isolated browser", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );
        yield* browser.use("Copy the MCP URL", (page) =>
          page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
        );
        const copiedUrl = yield* browser.use("Read the copied MCP URL", (page) =>
          page.evaluate(() => navigator.clipboard.readText()),
        );
        if (copiedUrl !== endpoint)
          return yield* new OnboardingFailed({ operation: "Copy the exact public MCP URL" });
        yield* browser.use("Copy the starter prompt", (page) =>
          page.getByRole("button", { name: "Copy starter prompt", exact: true }).click(),
        );
        const prompt = yield* browser.use("Read the copied starter prompt", (page) =>
          page.evaluate(() => navigator.clipboard.readText()),
        );
        if (
          !prompt.includes(endpoint) ||
          !prompt.includes(`${targetHosts(target).edge}/docs/`) ||
          !prompt.includes("help me get my first app set up")
        )
          return yield* new OnboardingFailed({
            operation: "The starter prompt includes MCP, documentation, and first-app setup",
          });
        const team = teams[0];
        yield* browser.use("Open the dashboard when ready", (page) =>
          page.getByRole("link", { name: "Open dashboard", exact: false }).click(),
        );
        yield* browser.use("The new team opens Apps", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/org/${team.slug}/apps`),
        );
        yield* browser.use("The confirmed team stays open", (page) =>
          page
            .getByRole("link", { name: "Add app", exact: true })
            .first()
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Team opens without a setup screen");
        yield* browser.use("The background Executor app appears without a reload", (page) =>
          page
            .getByRole("link", { name: "Open Executor", exact: true })
            .waitFor({ state: "visible", timeout: 90000 }),
        );
        yield* browser.checkpoint("Executor appears after background provisioning");
        yield* browser.use("Reload the provisioned team", (page) => page.reload());
        yield* browser.use("The installed app remains available", (page) =>
          page.getByRole("link", { name: "Open Executor", exact: true }).waitFor(),
        );
        yield* evidence.json("created-team.json", teams[0]);
        return teams[0];
      }),
    signOut: Effect.gen(function* () {
      yield* browser.use("Open the account menu", (page) =>
        page.getByRole("button", { name: /^Account: / }).click(),
      );
      yield* browser.use("Sign out of Cloud", (page) =>
        page.getByRole("menuitem", { name: "Sign out", exact: true }).click(),
      );
      // Cloud's browser origin opens sign-in for a signed-out visitor; elsewhere the public entry.
      const entry = target.metadata.target === "cloud" ? "/login" : "/";
      yield* browser.use("Return to the public entry", (page) =>
        page.waitForURL(
          (url) => url.origin === targetHosts(target).browser && url.pathname === entry,
        ),
      );
    }),
    passkey: Effect.gen(function* () {
      const session = yield* browser.use("Enable the browser's virtual authenticator", (page) =>
        page.context().newCDPSession(page),
      );
      yield* driver("Enable WebAuthn", () => session.send("WebAuthn.enable"));
      const authenticator = yield* driver("Create a virtual platform authenticator", () =>
        session.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        }),
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ authenticatorId: Schema.String })),
        ),
      );
      yield* Effect.addFinalizer(() =>
        driver("Close virtual authenticator", () => session.detach()).pipe(Effect.orDie),
      );
      yield* evidence.json("authenticator.json", {
        kind: "browser-virtual-platform",
        realWebAuthn: true,
        nativePasswordManagerDialog: false,
      });
      return {
        register: Effect.gen(function* () {
          yield* browser.use("Cloud offers passkey enrollment to the new email user", (page) =>
            page
              .getByRole("heading", { name: "Create a passkey", exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint("Email sign-in offers a passkey");
          yield* browser.use("Create a passkey through WebAuthn", (page) =>
            page.getByRole("button", { name: "Create a passkey", exact: true }).click(),
          );
          yield* browser.use("Passkey enrollment finishes", (page) =>
            page.waitForURL(
              (url) => url.origin === targetHosts(target).browser && url.pathname === "/create",
              { waitUntil: "domcontentloaded" },
            ),
          );
          const result = yield* driver("Read virtual authenticator registrations", () =>
            session.send("WebAuthn.getCredentials", {
              authenticatorId: authenticator.authenticatorId,
            }),
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  credentials: Schema.Array(Schema.Struct({ credentialId: Schema.String })),
                }),
              ),
            ),
          );
          if (result.credentials.length !== 1)
            return yield* new OnboardingFailed({ operation: "Expected one registered passkey" });
        }),
        signIn: Effect.gen(function* () {
          yield* openLogin;
          yield* browser.use("Sign in using the saved passkey", (page) =>
            page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click(),
          );
          yield* browser.use("Passkey returns to the existing team", (page) =>
            page.waitForURL(
              (url) =>
                url.origin === targetHosts(target).browser &&
                /^\/org\/[^/]+\/apps$/.test(url.pathname),
            ),
          );
          yield* browser.checkpoint("Returning sign-in with the saved passkey");
        }),
      };
    }),
  };
});
/** End-to-end onboarding through browser and external emulators, with real product sessions. */
export class Onboarding extends Context.Service<Onboarding, Effect.Success<typeof make>>()(
  "e2e/Onboarding",
) {
  static readonly layer = Layer.effect(Onboarding, make).pipe(Layer.provide(Emulators.layer));
}
