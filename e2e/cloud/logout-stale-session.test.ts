// Cloud-only: signing out must ALWAYS sign the browser out. The shell's
// sign-out is a top-level form POST (the WorkOS hop is cross-origin, so it
// can't be a fetch), which means whatever `/api/auth/logout` answers is
// rendered AS THE PAGE. An error response is therefore not a silent failure —
// it is a screenful of raw API JSON where the homepage should be. Reported
// from the field as `{"_tag":"Unauthorized"}`.
//
// The endpoint sits behind SessionAuth, so a browser whose sealed session no
// longer authenticates AT THE MOMENT OF THE CLICK gets the middleware's 401
// instead of being signed out. Reaching that state needs nothing exotic: a
// second open tab does it (sign out in one, the other's shell is still painted
// but its cookie is gone), and an expired or upstream-revoked session lands on
// the same branch. Signing out of a session that is already over is the one
// request that must never fail — the user is asking for the state they are
// already in.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

/** First `Set-Cookie` header for `name`, as the raw header string. */
const setCookieFor = (response: Response, name: string): string => {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header;
  }
  return "";
};

// Open the account dropdown and sign out. Bounded retry: a click can land
// while the shell is still hydrating and the radix menu never opens (same
// idiom as auth-hint / org-switcher).
const clickSignOut = async (page: Page) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /Test User/ }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click({ timeout: 5_000 });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
};

scenario(
  "Sign-out · a browser whose session is already over is signed out, not handed an API error page",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    // Two ways a real browser arrives here holding no live session: it never
    // had one (the cookie was cleared, or sign-out is re-submitted from
    // history), and it holds one that no longer authenticates (expired, or
    // revoked upstream). Both POST the same form the shell posts.
    const signOut = (cookie?: string) =>
      Effect.promise(() =>
        fetch(new URL("/api/auth/logout", target.baseUrl), {
          method: "POST",
          redirect: "manual",
          ...(cookie ? { headers: { cookie } } : {}),
        }),
      );

    for (const [label, cookie] of [
      ["no session cookie at all", undefined],
      ["a session cookie that no longer authenticates", "wos-session=stale-sealed-session"],
    ] as const) {
      const response = yield* signOut(cookie);
      const body = yield* Effect.promise(() => response.text());

      // The response IS the page the user reads. This is the reported symptom.
      expect(body, `sign-out with ${label} never renders an API error envelope`).not.toContain(
        "_tag",
      );
      expect(response.status, `sign-out with ${label} sends the browser onward`).toBe(302);
      expect(
        new URL(response.headers.get("location") ?? "", target.baseUrl).pathname,
        `sign-out with ${label} lands the browser home`,
      ).toBe("/");
      // Nothing to end upstream without a session, but the browser must still
      // leave with its cookies dropped — a stale session cookie left in place
      // keeps routing / into the app instead of marketing.
      expect(
        setCookieFor(response, "wos-session"),
        `sign-out with ${label} still clears the session cookie`,
      ).toContain("Max-Age=0");
    }
  }),
);

scenario(
  "Sign-out · a second open tab signs out too instead of showing raw JSON",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    // `page` is the tab the user is LOOKING at when it breaks — the run's
    // video and screenshots follow it, so the artifacts show the reported
    // symptom rather than the tab that already signed out cleanly.
    yield* browser.session(identity, async ({ page, step }) => {
      const otherTab = await page.context().newPage();

      await step("The user has the app open in two tabs", async () => {
        await page.goto("/", { waitUntil: "commit" });
        await page.getByRole("link", { name: "Policies" }).waitFor();
        await otherTab.goto("/", { waitUntil: "commit" });
        await otherTab.getByRole("link", { name: "Policies" }).waitFor();
      });

      await step("Sign out in the other tab", async () => {
        await clickSignOut(otherTab);
        await otherTab.waitForURL((url) => url.pathname === "/" || url.pathname === "/login", {
          timeout: 15_000,
        });
      });

      // This tab was never told: its shell is still painted, and its sign-out
      // button still works the only way it knows how.
      const before = page.url();
      await step("Sign out in this tab, which still shows the app", async () => {
        await clickSignOut(page);
        await page.waitForURL((url) => url.toString() !== before, {
          timeout: 15_000,
        });
        await page.waitForLoadState("networkidle");
      });

      const shown = (await page.locator("body").innerText()).trim();
      expect(shown, "sign-out never renders the API's error envelope as a page").not.toContain(
        "_tag",
      );
      expect(
        new URL(page.url()).pathname,
        "this tab lands on a signed-out page like the other one",
      ).toMatch(/^\/(login)?$/);
      expect(
        (await page.context().cookies()).map((cookie) => cookie.name),
        "the browser is left with no session either way",
      ).not.toContain("wos-session");
    });
  }),
);
