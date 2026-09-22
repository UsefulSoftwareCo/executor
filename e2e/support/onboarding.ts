import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Browser } from "./browser.ts";
import { holdOrganizationEntry } from "./organization-entry.ts";
import { Emulators } from "./emulators.ts";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";

const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
);
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
  const emailSignIn = (email: string) =>
    Effect.gen(function* () {
      yield* openLogin;
      yield* browser.use("Enter the synthetic email", (page) =>
        page.getByLabel("Email", { exact: true }).fill(email),
      );
      const received = yield* emulators.received(email);
      yield* browser.use("Request a real sign-in code", (page) =>
        page.getByRole("button", { name: "Email me a code", exact: true }).click(),
      );
      const code = yield* evidence.step(
        "Read the delivered code from the mail emulator",
        emulators.mail(email, received),
      );
      yield* browser.use("Enter the delivered sign-in code", (page) =>
        page.getByLabel("Sign-in code", { exact: true }).fill(Redacted.value(code)),
      );
      yield* browser.use("Verify the sign-in code", (page) =>
        page.getByRole("button", { name: "Sign in", exact: true }).click(),
      );
      yield* browser.use("Sign-in advances to enrollment or the destination", (page) =>
        page.waitForFunction(
          (origin) =>
            window.location.origin === origin &&
            (window.location.pathname !== "/login" ||
              document.querySelector("h1")?.textContent === "Create a passkey"),
          target.metadata.origin,
        ),
      );
    });
  return {
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
        yield* browser.use(`Choose ${provider} sign-in`, (page) =>
          page
            .getByRole("button", {
              name: provider === "google" ? "Continue with Google" : "Continue with GitHub",
              exact: true,
            })
            .click(),
        );
        const document = yield* browser.use(
          `Choose the identity on the ${provider} emulator`,
          (page) =>
            Promise.all([
              page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().isNavigationRequest() &&
                  url.origin === target.metadata.origin &&
                  url.pathname === "/login"
                );
              }),
              page.getByRole("button").filter({ hasText: identity.email }).click(),
            ]).then(([response]) =>
              response.text().then((html) => ({
                status: response.status(),
                prepared: html.includes('id="executor-entry"') && html.includes('"path":"/create"'),
                private: response.headers()["cache-control"]?.includes("no-store") === true,
              })),
            ),
        );
        if (document.status !== 200)
          return yield* new OnboardingFailed({ operation: "Sign-in document did not load" });
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
            (url) => url.origin === target.metadata.origin && url.pathname !== "/login",
          ),
        );
        yield* evidence.json("identity-provider.json", {
          provider,
          emulated: true,
          sessionInjected: false,
        });
        return identity;
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
        yield* browser.use("The new team opens Apps", (page) =>
          page.waitForURL(
            (url) =>
              url.origin === target.metadata.origin && /^\/org\/[^/]+\/apps$/.test(url.pathname),
          ),
        );
        const teams = yield* organizations;
        if (teams.length !== 1 || teams[0]?.name !== name)
          return yield* new OnboardingFailed({
            operation: "Confirmation must create exactly the chosen team",
          });
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
      yield* browser.use("Sign out of Cloud", (page) =>
        page.getByRole("button", { name: "Sign out", exact: true }).click(),
      );
      yield* browser.use("Return to the public entry", (page) =>
        page.waitForURL((url) => url.origin === target.metadata.origin && url.pathname === "/"),
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
            page
              .getByRole("heading", { name: "Create a passkey", exact: true })
              .waitFor({ state: "hidden" }),
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
                url.origin === target.metadata.origin && /^\/org\/[^/]+\/apps$/.test(url.pathname),
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
