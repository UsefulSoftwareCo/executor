// Cloud-specific: the auth-hint lifecycle that lets the app paint the REAL
// authenticated shell with no full-page skeleton, ever. The sealed session is
// HttpOnly, so the SPA can't derive identity from it — instead the SSR gate
// verifies the session per document request, renders the shell from that
// verified identity, and MINTS the non-HttpOnly hint cookie
// (executor-auth-hint) when the browser doesn't hold a current one. From
// then on AuthProvider keeps the hint fresh on every confirmed /account/me
// and logout takes it away with the session.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const HINT_COOKIE = "executor-auth-hint";

scenario(
  "Auth hint · the FIRST load on a fresh browser paints the real shell — the gate minted the hint",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      // Hold the auth probe open from the very first request. This browser
      // has NEVER loaded the app — no hint cookie exists — which used to be
      // the one case that still showed a full-page skeleton for the whole
      // /account/me round trip.
      let probeResolved = false;
      await page.route("**/api/account/me", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        probeResolved = true;
        await route.continue();
      });

      await step("First-ever load: the real app shell, immediately", async () => {
        await page.goto("/", { waitUntil: "commit" });
        // Real nav text — a skeleton has no text at all.
        await page.getByRole("link", { name: "Policies" }).waitFor();
      });

      expect(probeResolved, "the shell did NOT wait for /account/me").toBe(false);
      // The full-page skeleton was a text-free silhouette; the real shell has
      // the nav AND this identity's own data in the footer — the SSR render
      // knew who it was serving. (Per-SECTION skeletons for in-flight data
      // are fine; the silhouette of the whole app is what must never paint.)
      // newIdentity names the org after the user (`Org user-xxxx`), so the
      // footer's org line is identity-specific text no other user would show.
      const orgName = `Org ${identity.label.split("@")[0]}`;
      expect(
        await page.getByText(orgName).first().isVisible(),
        "the shell footer shows THIS identity's organization",
      ).toBe(true);

      // The identity the shell painted from is now pinned for next time: the
      // gate minted the hint cookie on the document response itself.
      const hint = (await page.context().cookies()).find((c) => c.name === HINT_COOKIE);
      expect(hint, "the gate minted the hint on the first response").toBeTruthy();
      expect(hint!.httpOnly, "the hint is readable by the SPA — that's its job").toBe(false);
      expect(
        decodeURIComponent(hint!.value),
        "it carries the verified identity (display data only)",
      ).toContain(identity.label);
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
      await step("Load the app signed in (the hint arrives with it)", async () => {
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
