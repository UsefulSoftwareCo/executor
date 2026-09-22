import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { holdOrganizationEntry } from "../support/organization-entry.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { Onboarding } from "../support/onboarding.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Cloud onboarding", (it) => {
  it.effect(scenarios.onboardingGoogle.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding;
        const loading = yield* onboarding.delayPreparation;
        const identity = yield* onboarding.socialSignIn("google");
        yield* loading.show;
        expect(yield* onboarding.suggestedTeamName).toBe(identity.companyName);
        expect(yield* onboarding.organizations).toEqual([]);
        const name = yield* onboarding.prepareTeam;
        const team = yield* onboarding.confirmTeam(name);
        const browser = yield* Browser;
        yield* onboarding.signOut;
        const list = yield* holdOrganizationEntry;
        yield* browser.use("Return to Google sign-in without saved organization history", (page) =>
          page.goto("/login"),
        );
        yield* browser.use("Sign in again with Google", (page) =>
          page.getByRole("button", { name: "Continue with Google", exact: true }).click(),
        );
        yield* browser.use("Select the existing synthetic Google identity", (page) =>
          page.getByRole("button").filter({ hasText: identity.email }).click(),
        );
        yield* list.release;
        yield* browser.use("Google returns directly to the existing team's Apps", (page) =>
          page.waitForURL(`**/org/${team.slug}/apps`),
        );
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingGithub.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          browser = yield* Browser;
        yield* browser.use("Use a phone viewport for first-team setup", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        const loading = yield* onboarding.delayPreparation;
        yield* onboarding.socialSignIn("github");
        yield* loading.show;
        yield* browser.use("Reload the dedicated setup URL", (page) => page.reload());
        const name = yield* onboarding.prepareTeam;
        const sessionRefresh = yield* holdQuery(["/api/auth/get-session"], "continue");
        yield* refreshVisiblePage;
        yield* sessionRefresh.requested;
        expect(
          yield* browser.use("The team draft survives session revalidation", (page) =>
            page.getByLabel("Team name", { exact: true }).inputValue(),
          ),
        ).toBe(name);
        yield* sessionRefresh.release;
        expect(yield* onboarding.organizations).toEqual([]);
        yield* onboarding.failConfirmationOnce;
        yield* browser.use("Try team confirmation during a network failure", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Confirmation failure is visible", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "Unable to create your team" })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The edited name survives failure", (page) =>
            page.getByLabel("Team name", { exact: true }).inputValue(),
          ),
        ).toBe(name);
        yield* browser.checkpoint("Team details retained for retry");
        const team = yield* onboarding.confirmTeam(name);
        yield* browser.use("Existing members can revisit the setup URL", (page) =>
          page.goto("/create"),
        );
        yield* browser.use(
          "Existing membership returns to Apps without another team form",
          (page) => page.waitForURL(`**/org/${team.slug}/apps`),
        );
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingEmail.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding;
        const authenticator = yield* onboarding.passkey;
        yield* onboarding.emailSignIn(yield* onboarding.freshEmail);
        yield* authenticator.register;
        expect(yield* onboarding.organizations).toEqual([]);
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        yield* onboarding.signOut;
        yield* authenticator.signIn;
        expect(yield* onboarding.organizations).toEqual([team]);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingSkip.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          browser = yield* Browser;
        yield* onboarding.passkey;
        const email = yield* onboarding.freshEmail;
        yield* onboarding.emailSignIn(email);
        yield* browser.use("Passkey enrollment is offered", (page) =>
          page
            .getByRole("heading", { name: "Create a passkey", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Passkey enrollment can be skipped");
        yield* browser.use("Choose Not now", (page) =>
          page.getByRole("button", { name: "Not now", exact: true }).click(),
        );
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        yield* onboarding.signOut;
        yield* onboarding.emailSignIn(email);
        yield* browser.use("Returning email user opens the existing team", (page) =>
          page.waitForURL(`**/org/${team.slug}/apps`),
        );
        expect(yield* onboarding.organizations).toEqual([team]);
        expect(
          yield* browser.use("Passkey enrollment stays dismissed", (page) =>
            page.getByRole("heading", { name: "Create a passkey", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Returning email user stays in their team");
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
