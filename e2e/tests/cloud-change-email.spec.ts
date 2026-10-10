/** A Cloud account moves to a new email only after both inboxes return their codes. */
import { expect, layer } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import type { Page } from "playwright";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Emulators } from "../support/emulators.ts";
import { Evidence } from "../support/evidence.ts";
import { Onboarding } from "../support/onboarding.ts";
import { scenarios } from "../test-plan.ts";

const Session = Schema.Struct({
  user: Schema.Struct({
    email: Schema.String,
    emailVerified: Schema.Boolean,
    name: Schema.String,
  }),
});

layer(TestLive, { excludeTestServices: true })("Cloud email change", (it) => {
  it.effect(scenarios.cloudChangeEmail.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          browser = yield* Browser,
          emulators = yield* Emulators,
          evidence = yield* Evidence;
        const original = yield* onboarding.freshEmail;
        const replacement = `changed-${randomUUID()}@example.test`;
        const session = browser
          .use("Read the signed-in user", (page) =>
            page.evaluate(() => fetch("/api/auth/get-session").then((response) => response.json())),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
        const shownEmail = browser.use("Read the profile email", (page) =>
          page.getByLabel("Email", { exact: true }).inputValue(),
        );

        yield* onboarding.emailSignIn(original);
        yield* browser.use("Open the profile", (page) => page.goto("/account/profile"));
        expect(yield* shownEmail).toBe(original);
        // An email-code sign-up has no name; the profile offers one without saving it.
        expect(
          yield* browser.use("Read the suggested name", (page) =>
            Promise.all([
              page.getByLabel("Name", { exact: true }).inputValue(),
              page.getByText("Suggested from your email. Save to use it.").isVisible(),
              page.getByRole("button", { name: "Save", exact: true }).isEnabled(),
            ]),
          ),
        ).toEqual([original.split("@")[0], true, true]);
        expect((yield* session).user.name).toBe("");
        yield* browser.checkpoint("A blank name starts as a suggestion and the email is locked");

        const dialog = (page: Page) => page.getByRole("dialog", { name: "Change email" });
        yield* browser.use("Open the email change", (page) =>
          page.getByRole("button", { name: "Change email", exact: true }).click(),
        );
        yield* browser.use("Let the dialog finish opening", (page) =>
          dialog(page)
            .getByLabel("New email", { exact: true })
            .waitFor()
            .then(() =>
              page.waitForFunction(() =>
                document.getAnimations().every((animation) => animation.playState !== "running"),
              ),
            ),
        );
        yield* browser.checkpoint("The dialog asks for the new address");
        yield* browser.use("Enter the current address as the new one", (page) =>
          dialog(page).getByLabel("New email", { exact: true }).fill(original),
        );
        yield* browser.use("Submit the unchanged address", (page) =>
          dialog(page).getByRole("button", { name: "Continue", exact: true }).click(),
        );
        expect(
          yield* browser.use("The unchanged address is refused", (page) =>
            dialog(page).getByRole("alert").innerText(),
          ),
        ).toBe("Enter an address other than your current email.");
        yield* browser.checkpoint("The new address must differ from the current one");
        yield* browser.use("Enter the new address", (page) =>
          dialog(page).getByLabel("New email", { exact: true }).fill(replacement),
        );
        const firstSent = yield* emulators.received(original);
        yield* browser.use("Ask the current address to approve", (page) =>
          dialog(page).getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Wait for the approval step", (page) =>
          dialog(page).getByLabel("Approval code", { exact: true }).waitFor(),
        );
        expect((yield* emulators.mail(original, firstSent)).subject).toBe(
          "Executor: Approve your email change",
        );
        const beforeResend = yield* emulators.received(original);
        yield* browser.checkpoint("The dialog asks for the approval code");
        // A resent code replaces the first one, so the rest of the flow uses the newest code.
        yield* browser.use("Resend the approval code", (page) =>
          dialog(page).getByRole("button", { name: "Resend code", exact: true }).click(),
        );
        yield* browser.use("The resend is confirmed", (page) =>
          dialog(page).getByRole("status").filter({ hasText: "Code sent" }).waitFor(),
        );
        yield* browser.checkpoint("The approval code can be resent");
        const approval = yield* evidence.step(
          "Read the resent approval code",
          emulators.mail(original, beforeResend),
        );
        expect(approval.subject).toBe("Executor: Approve your email change");
        const wrong = Redacted.value(approval.code) === "000000" ? "111111" : "000000";
        yield* browser.use("Enter a wrong approval code", (page) =>
          dialog(page).getByLabel("Approval code", { exact: true }).fill(wrong),
        );
        yield* browser.use("Submit the wrong approval code", (page) =>
          dialog(page).getByRole("button", { name: "Continue", exact: true }).click(),
        );
        expect(
          yield* browser.use("The wrong code is refused", (page) =>
            dialog(page).getByRole("alert").innerText(),
          ),
        ).toBe("This code is incorrect. Check the code and try again.");
        // No code reaches the new address before the current one approves the change.
        expect(yield* emulators.received(replacement)).toEqual([]);
        expect((yield* session).user.email).toBe(original);
        yield* browser.checkpoint("The current address must approve an email change");

        yield* browser.use("Enter the approval code", (page) =>
          dialog(page)
            .getByLabel("Approval code", { exact: true })
            .fill(Redacted.value(approval.code)),
        );
        yield* browser.use("Approve the change", (page) =>
          dialog(page).getByRole("button", { name: "Continue", exact: true }).click(),
        );
        const confirmation = yield* evidence.step(
          "Read the confirmation code sent to the new address",
          emulators.mail(replacement, []),
        );
        expect(confirmation.subject).toBe("Executor: Confirm your new email address");
        yield* browser.use("Wait for the confirmation step", (page) =>
          dialog(page).getByLabel("Confirmation code", { exact: true }).waitFor(),
        );
        // The account keeps its address until the new one proves it receives mail.
        expect((yield* session).user.email).toBe(original);
        yield* browser.checkpoint("The new address confirms with its own code");

        yield* browser.use("Enter the confirmation code", (page) =>
          dialog(page)
            .getByLabel("Confirmation code", { exact: true })
            .fill(Redacted.value(confirmation.code)),
        );
        yield* browser.use("Confirm the new address", (page) =>
          dialog(page).getByRole("button", { name: "Change email", exact: true }).click(),
        );
        yield* browser.use("The dialog closes", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );
        yield* browser.use("The change is confirmed", (page) =>
          page.getByRole("status").filter({ hasText: "Email changed" }).waitFor(),
        );
        expect(yield* shownEmail).toBe(replacement);
        expect((yield* session).user).toEqual({
          email: replacement,
          emailVerified: true,
          name: "",
        });
        yield* browser.checkpoint("The profile shows the new email");
        yield* browser.use("Reload the profile", (page) => page.reload());
        expect(yield* shownEmail).toBe(replacement);

        // The old address no longer names an account: its next code would create one.
        const freed = yield* emulators.received(original);
        expect(
          yield* browser.use("Request a code for the old address", (page) =>
            page.evaluate(
              (email) =>
                fetch("/api/auth/email-otp/send-verification-otp", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ email, type: "sign-in" }),
                }).then((response) => response.status),
              original,
            ),
          ),
        ).toBe(200);
        expect((yield* emulators.mail(original, freed)).subject).toBe("Your Executor sign-up code");
      }).pipe(Effect.provide(Layer.merge(Onboarding.layer, Emulators.layer))),
    ),
  );
});
