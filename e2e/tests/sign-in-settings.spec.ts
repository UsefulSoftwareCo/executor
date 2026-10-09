/**
 * Self-host sign-in reads whether first-run setup is open and whether SSO is configured on the
 * server, so it renders its own form. A stalled read must hold neither sign-in nor any other page.
 * Sign-in the browser opens after a session ends has no settings, so on an SSO instance it draws
 * nothing until the form arrives.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { startDevelopmentServer, startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
/** Stalls a document's settings read; see `apps/hosted/testing/access-check-fixture.ts`. */
const signInSettingsCookie = "executor-test-sign-in-settings";
/**
 * The fixture holds the read for 12 seconds, and sign-in gives up on it after 2. Headers arrived
 * 2.01–2.36 s after the request in local and review runs, the slowest on a host under heavy load;
 * the rest of a second allows for a loaded runner, and a deadline of 3 seconds or more fails.
 */
const signInHeadersWithinMs = 3_000;
/**
 * No other page reads the settings, so the stall cannot delay it. Those headers took 7–72 ms, and
 * up to 810 ms on a host under heavy load; a page that waited for the read would take at least
 * sign-in's 2-second deadline on top of its own time.
 */
const otherHeadersWithinMs = 1_500;
const settingsRoute = /\/api\/auth\/self-host\/config$/;

const desktop = { width: 1100, height: 700 },
  phone = { width: 390, height: 844 };

/** Collect React's hydration failures from the page, for the scenario to assert on. */
const watchHydration = (page: Page) => {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && hydrationFailure.test(message.text()))
      failures.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (hydrationFailure.test(String(error))) failures.push(String(error));
  });
  return failures;
};

/** Whether the page fits its viewport, so nothing on it needs scrolling into view. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);

/**
 * What the page draws: each visible element with no children that shows text, an image, a field,
 * a fill or a border. Text only a screen reader reads is not drawn.
 */
const drawn = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.body.querySelectorAll("*")).flatMap((element) => {
      const box = element.getBoundingClientRect(),
        style = getComputedStyle(element);
      const shows =
        element.children.length === 0 &&
        box.width > 0 &&
        box.height > 0 &&
        style.visibility !== "hidden" &&
        element.closest(".sr-only") === null &&
        (Boolean(element.textContent?.trim()) ||
          ["IMG", "INPUT", "SVG"].includes(element.tagName.toUpperCase()) ||
          style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          style.borderTopWidth !== "0px");
      return shows ? [`${element.tagName.toLowerCase()} at y=${box.y}`] : [];
    }),
  );

/** How long the server takes to start answering a document request. */
const headersAfter = (page: Page, url: string) => {
  const started = performance.now();
  return page.goto(url, { waitUntil: "commit" }).then((response) => ({
    ms: performance.now() - started,
    status: response?.status() ?? 0,
  }));
};

const hydrated = (page: Page) => page.locator("html[data-hydrated]").waitFor({ state: "attached" });

layer(TestLive, { excludeTestServices: true })("Sign-in settings", (it) => {
  it.effect(scenarios.signInSettingsStalled.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        // The test entry point mounts the fixture; the production one does not.
        const origin = yield* startDevelopmentServer(target);
        const failures = yield* browser.use("Watch hydration", (page) =>
          Promise.resolve(watchHydration(page)),
        );

        // Signed out with settings that answer: the server renders the form itself.
        const settled = yield* browser.use("Open sign-in", (page) =>
          page
            .goto(`${origin}/login`)
            .then(() => hydrated(page))
            .then(() => page.getByRole("heading", { level: 1 }).allTextContents()),
        );
        expect(settled).toEqual(["Sign in to Executor"]);
        expect(failures, "Sign-in hydrates as the server rendered it").toEqual([]);

        yield* browser.use("Stall the page's settings read", (page) =>
          page.context().addCookies([{ name: signInSettingsCookie, value: "stall", url: origin }]),
        );
        const signIn = yield* browser.use("Open sign-in while its settings stall", (page) =>
          headersAfter(page, `${origin}/login`),
        );
        expect(signIn.ms, "Sign-in's headers arrive by its deadline").toBeLessThan(
          signInHeadersWithinMs,
        );
        // The browser's own read answers, and its form replaces the loading screen.
        yield* browser.use("The browser reads the settings itself", (page) =>
          hydrated(page).then(() =>
            page.getByRole("heading", { level: 1, name: "Sign in to Executor" }).waitFor(),
          ),
        );
        yield* browser.checkpoint("Sign-in after its server read stalled");
        expect(failures, "The loading screen hydrates as the server rendered it").toEqual([]);

        // When the browser's read fails too, sign-in says so instead of guessing a form.
        yield* browser.use("Refuse the browser's settings read", (page) =>
          page.route(settingsRoute, (route) =>
            route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
          ),
        );
        const alert = yield* browser.use("Open sign-in while every settings read fails", (page) =>
          page
            .goto(`${origin}/login`, { waitUntil: "commit" })
            .then(() => page.getByRole("alert").textContent()),
        );
        expect(alert).toBe("Unable to load sign-in settings. Reload to try again.");
        expect(failures).toEqual([]);

        // Other pages never wait for the settings, signed out or in.
        yield* browser.use("Let the browser's settings read answer", (page) =>
          page.unrouteAll({ behavior: "ignoreErrors" }),
        );
        const redirect = yield* browser.use("Open an account page signed out", (page) => {
          const started = performance.now();
          return page
            .context()
            .request.get(`${origin}/account/profile`, { maxRedirects: 0 })
            .then((response) => ({ status: response.status(), ms: performance.now() - started }));
        });
        expect(redirect.status, "A signed-out account page redirects to sign-in").toBe(307);
        expect(redirect.ms, "The redirect does not wait for the stalled read").toBeLessThan(
          otherHeadersWithinMs,
        );
        expect(
          yield* browser.use("Sign in", (page) =>
            page
              .context()
              .request.post(`${origin}/api/devtools/operator`, { headers: { origin } })
              .then((response) => response.status()),
          ),
        ).toBe(200);
        const account = yield* browser.use("Open an account page signed in", (page) =>
          headersAfter(page, `${origin}/account/profile`),
        );
        expect(account.status).toBe(200);
        expect(account.ms, "A signed-in page does not wait for the stalled read").toBeLessThan(
          otherHeadersWithinMs,
        );
      }),
    ),
  );

  it.effect(scenarios.signInSettingsSso.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence,
          target = yield* Target;
        // An operator SSO configuration. No identity provider answers: the instance still offers
        // SSO, and only the form's shape is checked here.
        const origin = yield* startFreshSelfHost(target, {
          SSO_DISCOVERY_URL: "https://127.0.0.1:9/.well-known/openid-configuration",
          SSO_CLIENT_ID: "synthetic-client",
          SSO_CLIENT_SECRET: "synthetic-client-secret",
          SSO_ALLOWED_DOMAINS: "example.test",
        });
        const owner = {
          name: "Synthetic Owner",
          email: "owner@example.test",
          password: "Synthetic-e2e-password-2026",
        };
        const failures = yield* browser.use("Watch hydration", (page) =>
          Promise.resolve(watchHydration(page)),
        );
        expect(
          yield* browser.use("Set up the instance", (page) =>
            page
              .context()
              .request.post(`${origin}/api/auth/self-host/setup`, {
                headers: { origin },
                data: { ...owner, organizationName: "Synthetic SSO" },
              })
              .then((response) => response.status()),
          ),
        ).toBe(200);

        for (const viewport of [desktop, phone]) {
          const title = `SSO sign-in after the session ends at ${viewport.width}`;
          yield* browser.use(`${title}: open the dashboard`, (page) =>
            page
              .setViewportSize(viewport)
              .then(() => page.goto(`${origin}/`))
              .then(() => page.waitForURL(/\/org\/[^/]+\/apps/))
              .then(() => hydrated(page))
              .then(() => page.evaluate(() => document.fonts.ready)),
          );
          // Hold the sign-in page's code and any settings read, so the loading window stays open.
          let release = () => {};
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          let requested = () => {};
          const codeRequested = new Promise<void>((resolve) => {
            requested = resolve;
          });
          const [before, after] = yield* Effect.acquireRelease(
            browser.use(`${title}: hold sign-in's code and settings`, (page) =>
              Promise.all([
                page.route(/\/assets\/[^/]+\.js$/, (route) => {
                  requested();
                  return held.then(() => route.fallback());
                }),
                page.route(settingsRoute, (route) => held.then(() => route.fallback())),
              ]),
            ),
            () =>
              Effect.ignore(
                browser.use(`${title}: release sign-in's code and settings`, (page) => {
                  release();
                  return page.unrouteAll({ behavior: "ignoreErrors" });
                }),
              ),
          ).pipe(
            Effect.andThen(
              Effect.all([
                browser.use(`${title}: the loading window`, (page) =>
                  page
                    .context()
                    .clearCookies()
                    // The dashboard notices the ended session when the tab is shown again.
                    .then(() =>
                      page.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))),
                    )
                    .then(() => page.waitForURL(/\/login\?/))
                    .then(() => codeRequested)
                    .then(() =>
                      page
                        .getByRole("status")
                        .filter({ hasText: "Loading sign-in…" })
                        .waitFor({ state: "attached" }),
                    )
                    .then(() => page.evaluate(() => document.fonts.ready.then(() => undefined)))
                    .then(() => Promise.all([drawn(page), fits(page), page.screenshot()])),
                ),
                browser.use(`${title}: the form replaces it`, (page) => {
                  release();
                  return page
                    .getByRole("button", { name: "Continue with SSO", exact: true })
                    .waitFor()
                    .then(() => page.evaluate(() => document.fonts.ready.then(() => undefined)))
                    .then(() => Promise.all([fits(page), page.screenshot()]));
                }),
              ]),
            ),
            Effect.scoped,
          );
          yield* evidence.attach(`sso-loading-${viewport.width}.png`, "image/png", before[2]);
          yield* evidence.attach(`sso-ready-${viewport.width}.png`, "image/png", after[1]);
          // The dashboard did not arrive with the settings, so a card could not know the SSO
          // button is coming: nothing is drawn until the form is.
          expect(before[0], `${title}: the loading window draws nothing`).toEqual([]);
          expect(before[1], `${title}: the loading window does not scroll`).toBe(true);
          expect(after[0], `${title}: the form fits without scrolling`).toBe(true);
          expect(
            yield* browser.use(`${title}: sign in again`, (page) =>
              page
                .context()
                .request.post(`${origin}/api/auth/sign-in/email`, {
                  headers: { origin },
                  data: { email: owner.email, password: owner.password },
                })
                .then((response) => response.status()),
            ),
          ).toBe(200);
        }

        // A signed-out sign-in document arrives as the SSO form and hydrates without a mismatch.
        const signedOut = yield* browser.use("Open sign-in signed out", (page) =>
          page
            .context()
            .clearCookies()
            .then(() => page.goto(`${origin}/login`))
            .then(() => hydrated(page))
            .then(() =>
              page.getByRole("button", { name: "Continue with SSO", exact: true }).isVisible(),
            ),
        );
        expect(signedOut).toBe(true);
        expect(failures, "Sign-in hydrates as the server rendered it").toEqual([]);
      }),
    ),
  );
});
