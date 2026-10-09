/**
 * After Cloud's dashboard moved from its deployment origin to `app.`, passkeys made for the old
 * host cannot sign in. A failed passkey sign-in explains that and names the other ways in.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { driver, Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Cloud passkey after the move", (it) => {
  it.effect(scenarios.cloudPasskeyMoved.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const hosts = targetHosts(target);
        // The old host's sign-in page now opens on the browser origin.
        yield* browser.use("Open sign-in at the deployment origin", (page) =>
          page.goto(`${hosts.deployment}/login`),
        );
        yield* browser.use("Sign-in moved to the browser origin", (page) =>
          page.waitForURL(`${hosts.browser}/login`),
        );
        // A real authenticator that holds no passkey for this relying party.
        const session = yield* browser.use("Enable the browser's virtual authenticator", (page) =>
          page.context().newCDPSession(page),
        );
        yield* driver("Enable WebAuthn", () => session.send("WebAuthn.enable"));
        yield* driver("Create an empty virtual platform authenticator", () =>
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
        yield* browser.use("Try a passkey", (page) =>
          page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click(),
        );
        const notice = yield* browser.use("The sign-in page explains the moved passkey", (page) => {
          const status = page
            .getByRole("status")
            .filter({ hasText: "Passkey sign-in didn't finish." });
          return status.waitFor({ state: "visible" }).then(() => status.innerText());
        });
        expect(notice).toBe(
          `Passkey sign-in didn't finish. If you made your passkey on ${new URL(hosts.deployment).hostname} before sign-in moved, it no longer works. Sign in with email, Google or GitHub, then add a new passkey in account settings.`,
        );
        // A muted notice, not an error: the page shows no alert.
        expect(
          yield* browser.use("No error alert", (page) => page.locator(".auth-error").count()),
        ).toBe(0);
        yield* browser.checkpoint("Moved passkey notice");
      }),
    ),
  );
});
