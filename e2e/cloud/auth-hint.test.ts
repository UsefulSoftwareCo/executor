// Cloud-specific: the auth-hint cookie lifecycle. The sealed session is
// HttpOnly, so on a fresh page load the SPA can't know it's signed in until
// /account/me resolves — the hint (executor-auth-hint, non-HttpOnly, written
// by AuthProvider once /account/me confirms) is what lets the NEXT load paint
// the real app shell immediately instead of a skeleton. These scenarios pin
// the full loop: confirmed identity writes it, the next load seeds from it
// while the probe is still in flight, and logout takes it away.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const HINT_COOKIE = "executor-auth-hint";

scenario(
  "Auth hint · a confirmed session writes the hint, and the next load paints the real shell from it",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      const hintCookie = async () =>
        (await page.context().cookies()).find((cookie) => cookie.name === HINT_COOKIE);

      await step("First signed-in load → /account/me confirms → the hint is written", async () => {
        await page.goto("/", { waitUntil: "commit" });
        await page.getByRole("link", { name: "Policies" }).waitFor();
        // The write happens in an effect after /account/me resolves.
        await expect.poll(hintCookie, { timeout: 10_000 }).toBeTruthy();
      });

      const hint = (await hintCookie())!;
      expect(hint.httpOnly, "the hint is readable by the SPA — that's its job").toBe(false);
      expect(
        decodeURIComponent(hint.value),
        "it carries the confirmed identity (display data only)",
      ).toContain(identity.label);

      // Hold the auth probe open on the SECOND load. Without the hint this
      // window is a full-page skeleton; with it, the real shell.
      let probeResolved = false;
      await page.route("**/api/account/me", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        probeResolved = true;
        await route.continue();
      });

      await step("Reload: the real app shell paints while /account/me is in flight", async () => {
        await page.goto("/", { waitUntil: "commit" });
        // Real nav text — the loading skeleton has no text at all.
        await page.getByRole("link", { name: "Policies" }).waitFor();
      });

      expect(probeResolved, "the shell did NOT wait for /account/me — the hint seeded it").toBe(
        false,
      );
      expect(
        await page.getByRole("link", { name: "Billing" }).isVisible(),
        "it is the full signed-in nav, not a placeholder",
      ).toBe(true);
    });
  }),
);

scenario(
  "Auth hint · logout clears the hint with the session",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Load the app signed in (the hint gets written)", async () => {
        await page.goto("/", { waitUntil: "commit" });
        await page.getByRole("link", { name: "Policies" }).waitFor();
        await expect
          .poll(async () => (await page.context().cookies()).some((c) => c.name === HINT_COOKIE), {
            timeout: 10_000,
          })
          .toBe(true);
      });

      await step("Sign out through the product flow", async () => {
        // The shell's sign-out POSTs the logout endpoint from the page, so
        // the response's Set-Cookie clears apply to this browser context.
        await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
      });

      const names = (await page.context().cookies()).map((cookie) => cookie.name);
      expect(names, "the hint never outlives the session").not.toContain(HINT_COOKIE);
      expect(names, "the session itself is gone too").not.toContain("wos-session");
    });
  }),
);
