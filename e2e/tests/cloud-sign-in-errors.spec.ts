import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Cloud sign-in errors", (it) => {
  it.effect(scenarios.cloudSignInErrors.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        // Better Auth returns a refused social sign-in to the login page with only its code.
        for (const [error, message] of [
          [
            "account_not_linked",
            "An Executor account already uses this email. Sign in with the method you used before.",
          ],
          [
            "unable_to_link_account",
            "This email is not linked to this sign-in method. Contact an administrator.",
          ],
          ["access_denied", "Sign-in was canceled. You can try again."],
          ["validation_failed", "Sign-in could not be completed. Please try again."],
        ] as const) {
          const shown = yield* browser.use(`Open sign-in after ${error}`, (page) =>
            page
              .goto(`/login?redirect=%2F&error=${error}`)
              .then(() => page.getByText(message).waitFor())
              .then(() => page.getByText(message).count()),
          );
          expect(shown, error).toBe(1);
          yield* browser.checkpoint(`Sign-in after ${error}`);
        }
      }),
    ),
  );
});
