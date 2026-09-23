/** Real Cloud onboarding keeps local work through background read transitions. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Onboarding } from "../support/onboarding.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Cloud enrollment refresh", (it) => {
  it.effect(scenarios.enrollmentRefresh.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding;
        const browser = yield* Browser;
        yield* onboarding.passkey;
        yield* onboarding.emailSignIn(yield* onboarding.freshEmail);
        yield* browser.use("Fail one passkey enrollment request", (page) =>
          page.route(
            "**/api/auth/passkey/generate-register-options*",
            (route) => route.abort("failed"),
            { times: 1 },
          ),
        );
        yield* browser.use("Try to create a passkey", (page) =>
          page.getByRole("button", { name: "Create a passkey", exact: true }).click(),
        );
        const message = "Passkey was not added. Try again or choose Not now to continue.";
        yield* browser.use("Enrollment failure is visible", (page) =>
          page.getByText(message, { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Focus enrollment choice", (page) =>
          page.getByRole("button", { name: "Not now", exact: true }).focus(),
        );
        const assertEnrollment = () =>
          Effect.gen(function* () {
            expect(
              yield* browser.use("Enrollment remains visible", (page) =>
                page.getByRole("heading", { name: "Create a passkey", exact: true }).count(),
              ),
            ).toBe(1);
            expect(
              yield* browser.use("Enrollment error remains", (page) =>
                page.getByText(message, { exact: true }).count(),
              ),
            ).toBe(1);
            expect(
              yield* browser.use("Enrollment choice retains focus", (page) =>
                page
                  .getByRole("button", { name: "Not now", exact: true })
                  .evaluate((button) => button === document.activeElement),
              ),
            ).toBe(true);
          });
        for (const outcome of ["continue", "fail"] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* holdQuery(["/api/auth/get-session"], outcome);
              yield* refreshVisiblePage;
              yield* held.requested;
              yield* assertEnrollment();
              yield* held.release;
              if (outcome === "fail")
                yield* browser.use("Session failure is shown inline", (page) =>
                  page
                    .getByText("Unable to check your session.", { exact: true })
                    .waitFor({ state: "visible" }),
                );
              yield* assertEnrollment();
              yield* browser.checkpoint(`Enrollment survives ${outcome} session refresh`);
            }),
          );
        }
        yield* refreshVisiblePage;
        yield* browser.use("Session recovers", (page) =>
          page
            .getByText("Unable to check your session.", { exact: true })
            .waitFor({ state: "hidden" }),
        );
        yield* assertEnrollment();
        const signedOut = yield* browser.use("End the real session as another tab would", (page) =>
          page.context().request.post("/api/auth/sign-out", {
            data: {},
            headers: { origin: new URL(page.url()).origin },
          }),
        );
        expect(signedOut.status()).toBe(200);
        yield* refreshVisiblePage;
        yield* browser.use("Confirmed sign-out replaces enrollment", (page) =>
          page.getByLabel("Email", { exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Sign-out resets the previous email", (page) =>
            page.getByLabel("Email", { exact: true }).inputValue(),
          ),
        ).toBe("");
        expect(
          yield* browser.use("Sign-out resets the code step", (page) =>
            page.getByLabel("Sign-in code", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Confirmed sign-out starts a fresh sign-in form");
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
