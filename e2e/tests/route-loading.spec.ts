import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openInApp } from "../support/in-app-navigation.ts";
import { Target, type DriverFailed } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** The visible level-one headings, in page order; a placeholder heading has no text. */
const headings = (page: Page) =>
  page
    .getByRole("heading", { level: 1 })
    .filter({ visible: true })
    .allTextContents()
    .then((texts) => texts.map((text) => text.trim()));

/**
 * Where the page draws its first visible level-one heading. Its width follows whatever the header
 * holds beside it, such as actions that load later, so only its position counts.
 */
const headingAt = (page: Page) =>
  page
    .getByRole("heading", { level: 1 })
    .filter({ visible: true })
    .first()
    .boundingBox()
    .then((box) => box && { x: box.x, y: box.y });

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

/**
 * Open a document as the server streamed it. Its scripts are refused, including React's inline
 * reveals, so the page stays at its first paint: the server's loading fallback for every region
 * still waiting, or the page itself where it was ready. That is the window a person sees before
 * the page streams in.
 */
const firstPaint = (page: Page, path: string) =>
  page
    .route(
      (url) => url.pathname === path.split("?")[0],
      (route) =>
        route.fetch().then((response) =>
          route.fulfill({
            response,
            headers: {
              ...response.headers(),
              "content-security-policy": "script-src 'none'",
            },
          }),
        ),
    )
    .then(() => page.goto(path, { waitUntil: "load" }))
    .then(() =>
      Promise.all([
        headings(page),
        page.evaluate(() => document.documentElement.hasAttribute("data-hydrated")),
        headingAt(page),
        page.screenshot(),
      ]),
    )
    .then(([visible, hydrated, heading, screenshot]) => ({
      visible,
      hydrated,
      heading,
      screenshot,
    }))
    // The page can never hydrate; later steps start from a page that is not a dashboard.
    .finally(() =>
      page.unrouteAll({ behavior: "ignoreErrors" }).then(() => page.goto("about:blank")),
    );

/** The same document once it has hydrated and `ready` resolves, where it draws its heading. */
const readyPaint = (page: Page, path: string, ready: (page: Page) => Promise<unknown>) =>
  page
    .goto(path)
    .then(() => page.locator("html[data-hydrated]").waitFor({ state: "attached" }))
    .then(() => ready(page))
    .then(() => Promise.all([headingAt(page), fits(page), page.screenshot()]))
    .then(([heading, fitted, screenshot]) => ({ heading, fits: fitted, screenshot }))
    .finally(() => page.goto("about:blank"));

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;

/** Run `use` at a viewport size, then return the page to the size it had. */
const atViewport = <A>(
  page: Page,
  size: { readonly width: number; readonly height: number } | undefined,
  use: () => Promise<A>,
) => {
  const previous = page.viewportSize();
  if (size === undefined || previous === null) return use();
  return page
    .setViewportSize(size)
    .then(use)
    .finally(() => page.setViewportSize(previous));
};

const desktop = { width: 1100, height: 700 },
  phone = { width: 390, height: 844 };

layer(HostedLive, { excludeTestServices: true })("Route loading", (it) => {
  it.effect(scenarios.routeLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          target = yield* Target;
        const slug = actors.organization.slug;
        const cloud = target.metadata.target === "cloud";
        const signIn = cloud ? "Sign in" : "Sign in to Executor";

        /**
         * Before any script runs, the page shows its own heading or a placeholder for it, never
         * another page's. Where the loading view is a card the ready page keeps, the heading is
         * where the ready page draws it, at the same viewport, so nothing moves when it arrives.
         */
        const checkPaint = ({
          label,
          path,
          allowed,
          ready,
          viewport,
          fit = false,
        }: {
          readonly label: string;
          readonly path: string;
          readonly allowed: ReadonlyArray<string>;
          readonly ready?: ((page: Page) => Promise<unknown>) | undefined;
          readonly viewport?: typeof desktop | undefined;
          /** The ready page must fit the viewport: a card that has room is not pushed below it. */
          readonly fit?: boolean | undefined;
        }) =>
          Effect.gen(function* () {
            const name = viewport === undefined ? label : `${label} ${viewport.width}`;
            const paint = yield* browser.use(`${name}: the server's first paint`, (page) =>
              atViewport(page, viewport, () => firstPaint(page, path)),
            );
            expect(paint.hydrated, `${name} was read before any script ran`).toBe(false);
            expect(paint.visible, `${name} shows its own heading`).not.toEqual([]);
            for (const heading of paint.visible) expect(allowed).toContain(heading);
            yield* evidence.attach(`first-paint-${name}.png`, "image/png", paint.screenshot);
            if (ready === undefined) return;
            const settled = yield* browser.use(`${name}: the ready page`, (page) =>
              atViewport(page, viewport, () => readyPaint(page, path, ready)),
            );
            yield* evidence.attach(`ready-${name}.png`, "image/png", settled.screenshot);
            expect(settled.heading, `${name}'s heading moved when the page arrived`).toEqual(
              paint.heading,
            );
            if (fit) expect(settled.fits, `${name} fits without scrolling`).toBe(true);
          });

        // Sign-in is resolved before the server renders it, so its first paint is the form itself,
        // centred where the ready page keeps it. A return to an invitation adds a way to join below
        // the form. First-run setup cannot be opened here: the instance is already set up.
        const invitationReturn = "/login?redirect=%2Finvite%3Finvitation%3Dsynthetic-invitation";
        const hydrationFailures = yield* browser.use("Watch hydration", (page) => {
          const failures: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error" && hydrationFailure.test(message.text()))
              failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          return Promise.resolve(failures);
        });
        const signInPaths = cloud
          ? [["Sign-in", "/login"] as const]
          : ([
              ["Sign-in", "/login"],
              ["Invitation sign-in", invitationReturn],
            ] as const);
        for (const [label, path] of signInPaths)
          for (const viewport of [desktop, phone])
            yield* checkPaint({
              label,
              path,
              allowed: [signIn],
              // Both products ask for an email address first.
              ready: (page) => page.getByRole("textbox").first().waitFor(),
              viewport,
              fit: !cloud,
            });
        // Joining asks for a name too; the taller card still fits a laptop screen.
        if (!cloud)
          for (const viewport of [desktop, phone]) {
            const joined = yield* browser.use(
              `Join with an invitation at ${viewport.width}`,
              (page) =>
                atViewport(page, viewport, () =>
                  page
                    .goto(invitationReturn)
                    .then(() => page.locator("html[data-hydrated]").waitFor({ state: "attached" }))
                    .then(() =>
                      page.getByRole("button", { name: "Join with this invitation" }).click(),
                    )
                    .then(() =>
                      page.getByRole("heading", { level: 1, name: "Join Executor" }).waitFor(),
                    )
                    .then(() => Promise.all([fits(page), page.screenshot()])),
                ),
            );
            yield* evidence.attach(`joined-${viewport.width}.png`, "image/png", joined[1]);
            expect(joined[0], `Joining fits at ${viewport.width}`).toBe(true);
          }
        expect(hydrationFailures, "Signed-out sign-in hydrates as the server rendered it").toEqual(
          [],
        );

        yield* browser.login(actors.owner);
        yield* checkPaint({
          label: "Profile",
          path: "/account/profile",
          allowed: ["Profile"],
        });
        // An unknown client: the consent card loads, then says the request cannot be loaded.
        yield* checkPaint({
          label: "MCP consent",
          path: "/mcp/authorize?client_id=client_route_loading&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback",
          allowed: ["Connect to Executor"],
          ready: (page) =>
            page.getByText("Start again from your MCP client.", { exact: true }).waitFor(),
        });
        yield* checkPaint({
          label: "Groups",
          path: `/org/${slug}/groups`,
          allowed: ["Groups"],
        });
        yield* checkPaint({
          label: "Approvals",
          path: `/org/${slug}/approvals`,
          allowed: ["Approvals"],
        });
        // The entry opens the organization's apps once its memberships are known, so self-host's
        // entry already draws the apps page's frame and heading. Cloud's entry checks for a first
        // team in its own card, which then gives way to the apps page.
        yield* checkPaint({
          label: "Entry",
          path: "/",
          allowed: [cloud ? "Opening Executor" : "Apps"],
          // The organization and its apps replace their placeholders once the apps page opens.
          ready: cloud
            ? undefined
            : (page) =>
                page
                  .waitForURL(`**/org/${slug}/apps`)
                  .then(() =>
                    Promise.all(
                      ["Loading organization", "Loading app search"].map((label) =>
                        page.getByLabel(label, { exact: true }).waitFor({ state: "detached" }),
                      ),
                    ),
                  ),
        });

        /**
         * Open `path` in the running dashboard from a page that loads none of it, holding every
         * later script until `whileHeld` has looked at the loading window. `whileHeld` receives
         * the release, so it can watch the page arrive. `open` replaces the in-app navigation with
         * whatever makes the dashboard open the page itself; `alsoHold` holds a request the page
         * makes once its code has arrived.
         */
        const openWithCodeHeld = <A, E, R>(
          title: string,
          path: string,
          whileHeld: (release: Effect.Effect<void, DriverFailed>) => Effect.Effect<A, E, R>,
          {
            open = openInApp(`Open ${title}`, path),
            alsoHold,
          }: {
            readonly open?: Effect.Effect<void, DriverFailed, Browser>;
            readonly alsoHold?: RegExp;
          } = {},
        ) =>
          Effect.gen(function* () {
            yield* browser.use("Open a page that loads neither destination", (current) =>
              current.goto(`/org/${slug}/connect`),
            );
            let releaseScripts = () => {};
            const scripts = new Promise<void>((resolve) => {
              releaseScripts = resolve;
            });
            let scriptHeld = () => {};
            const held = new Promise<void>((resolve) => {
              scriptHeld = resolve;
            });
            const assets = /\/assets\/[^/]+\.js$/;
            const holds = alsoHold === undefined ? [assets] : [assets, alsoHold];
            return yield* Effect.acquireRelease(
              browser.use(`${title}: hold the page's code`, (current) =>
                Promise.all(
                  holds.map((pattern) =>
                    current.route(pattern, (route) => {
                      if (pattern === assets) scriptHeld();
                      return scripts.then(() => route.fallback());
                    }),
                  ),
                ),
              ),
              () =>
                Effect.ignore(
                  browser.use(`${title}: release the page's code`, (current) => {
                    releaseScripts();
                    return Promise.all(holds.map((pattern) => current.unroute(pattern)));
                  }),
                ),
            ).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  yield* open;
                  yield* browser.use(`${title}: its code was requested and is held`, () => held);
                  return yield* whileHeld(
                    browser.use(`${title}: let the code arrive`, () => {
                      releaseScripts();
                      return Promise.resolve();
                    }),
                  );
                }),
              ),
              Effect.scoped,
            );
          });

        // In the running dashboard, a page whose code has not arrived shows that page's frame and
        // loading state, then the page replaces it in place.
        const pages = [
          [
            "Groups",
            "groups",
            "Loading groups",
            (current: Page) => current.getByText("No groups yet", { exact: true }),
          ],
          [
            "Approvals",
            "approvals",
            "Loading",
            (current: Page) => current.getByText("No approvals waiting", { exact: true }),
          ],
        ] as const;
        for (const [title, page, status, arrived] of pages)
          yield* openWithCodeHeld(title, `/org/${slug}/${page}`, (release) =>
            Effect.gen(function* () {
              const before = yield* browser.use(`${title}: the loading window`, (current) =>
                current
                  .getByRole("status", { name: status, exact: true })
                  .first()
                  .waitFor({ state: "visible" })
                  .then(() =>
                    Promise.all([
                      headings(current),
                      current.getByRole("heading", { level: 1, name: title }).boundingBox(),
                    ]),
                  ),
              );
              expect(before[0]).toEqual([title]);
              yield* browser.checkpoint(`${title}: loading window while its code is held`);
              yield* release;
              const after = yield* browser.use(`${title}: the page replaces it`, (current) =>
                arrived(current)
                  .waitFor({ state: "visible" })
                  .then(() =>
                    current.getByRole("heading", { level: 1, name: title }).boundingBox(),
                  ),
              );
              expect(after, `${title}'s heading moved when the page arrived`).toEqual(before[1]);
            }),
          );

        /**
         * Record every status the page adds and each text it says, so a check can tell an
         * announcement (text that changes inside a live region) from text it held when it appeared.
         */
        const recordStatuses = (current: Page) =>
          current.evaluate(() => {
            const said: Array<{ added: string; later: Array<string> }> = [];
            const seen = new Map<Element, (typeof said)[number]>();
            const record = () => {
              for (const status of document.querySelectorAll('[role="status"]')) {
                const text = status.textContent ?? "";
                const entry = seen.get(status);
                if (entry === undefined) {
                  const added = { added: text, later: [] as Array<string> };
                  seen.set(status, added);
                  said.push(added);
                } else if (text !== (entry.later.at(-1) ?? entry.added)) entry.later.push(text);
              }
            };
            new MutationObserver(record).observe(document.body, {
              subtree: true,
              childList: true,
              characterData: true,
            });
            Object.assign(window, { statusesSaid: said });
          });
        const statusesSaid = (current: Page) =>
          current.evaluate(
            () =>
              (
                window as unknown as {
                  statusesSaid: Array<{ added: string; later: Array<string> }>;
                }
              ).statusesSaid,
          );

        /** The loading status saying `text`, and everything the page's statuses have said. */
        const statusSaying = (current: Page, text: string) =>
          Promise.all([
            current
              .getByRole("status")
              .filter({ hasText: text })
              .evaluate((element) => ({
                insideBusy: element.closest('[aria-busy="true"]') !== null,
                text: element.textContent,
                room: element.parentElement?.getBoundingClientRect().height ?? 0,
              })),
            statusesSaid(current),
          ]).then(([status, said]) => ({ ...status, said }));

        /**
         * A loading status a screen reader hears: a live region outside any busy region, which
         * appeared empty and then said `text`. Assistive technology may hold back what a busy
         * region says until it is no longer busy, and need not announce what a live region held
         * when it appeared.
         */
        const expectAnnounced = (
          title: string,
          status: Awaited<ReturnType<typeof statusSaying>>,
          text: string,
        ) => {
          expect(status.insideBusy, `${title}'s status is outside any busy region`).toBe(false);
          expect(status.text).toBe(text);
          expect(status.said, `${title}'s status said its text after it appeared`).toContainEqual({
            added: "",
            later: [text],
          });
        };

        // A page the dashboard cannot name stays blank rather than guess, but still says it is
        // loading: inside the dashboard for a connection link, and across the whole screen for a
        // page outside any organization.
        const unnamed = [
          [
            "A connection",
            `/org/${slug}/connections/con_00000000-0000-4000-8000-000000000000`,
            "in the dashboard",
          ],
          ["An invitation", "/invite", "across the screen"],
        ] as const;
        for (const [title, path, extent] of unnamed)
          yield* openWithCodeHeld(
            title,
            path,
            () =>
              Effect.gen(function* () {
                const status = yield* browser.use(`${title}: the loading window`, (current) =>
                  current
                    .getByRole("status")
                    .filter({ hasText: "Loading page…" })
                    .waitFor({ state: "attached" })
                    .then(() =>
                      Promise.all([statusSaying(current, "Loading page…"), current.viewportSize()]),
                    ),
                );
                yield* browser.checkpoint(`${title}: loading window while its code is held`);
                expectAnnounced(title, status[0], "Loading page…");
                expect(status[0].room, `${title} reserves room ${extent}`).toBeGreaterThanOrEqual(
                  extent === "across the screen" ? status[1]!.height : 200,
                );
              }),
            {
              open: Effect.andThen(
                browser.use(`${title}: watch its statuses`, recordStatuses),
                openInApp(`Open ${title}`, path),
              ),
            },
          );

        // A session that ends in the running dashboard opens sign-in in the browser. The dashboard
        // did not arrive with the sign-in settings, which decide the form's size, so until they
        // and the code arrive the screen draws nothing a form could move and says it is loading.
        // The settings read is held too. Self-host only: Cloud's sign-in has no settings to read.
        if (!cloud)
          for (const viewport of [desktop, phone]) {
            const title = `Sign-in after the session ends at ${viewport.width}`;
            const previous = yield* browser.use(`${title}: set the viewport`, (current) => {
              const size = current.viewportSize();
              return current.setViewportSize(viewport).then(() => size);
            });
            yield* browser.login(actors.owner);
            yield* openWithCodeHeld(
              title,
              "/login",
              (release) =>
                Effect.gen(function* () {
                  const before = yield* browser.use(`${title}: the loading window`, (current) =>
                    current
                      .waitForURL(/\/login\?/)
                      .then(() =>
                        current
                          .getByRole("status")
                          .filter({ hasText: "Loading sign-in…" })
                          .waitFor({ state: "attached" }),
                      )
                      .then(() =>
                        Promise.all([
                          statusSaying(current, "Loading sign-in…"),
                          drawn(current),
                          fits(current),
                        ]),
                      ),
                  );
                  yield* browser.checkpoint(`${title}: loading window while its code is held`);
                  expectAnnounced(title, before[0], "Loading sign-in…");
                  expect(before[1], `${title}: the loading window draws nothing`).toEqual([]);
                  expect(before[2], `${title}: the loading window does not scroll`).toBe(true);
                  yield* release;
                  const after = yield* browser.use(`${title}: the form replaces it`, (current) =>
                    current
                      .getByRole("heading", { level: 1, name: "Sign in to Executor" })
                      .waitFor()
                      .then(() => fits(current)),
                  );
                  expect(after, `${title}: the form fits without scrolling`).toBe(true);
                }),
              {
                // The dashboard notices the ended session when the tab is shown again.
                open: browser.use(`${title}: end the session`, (current) =>
                  recordStatuses(current)
                    .then(() => current.context().clearCookies())
                    .then(() =>
                      current.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))),
                    ),
                ),
                alsoHold: /\/api\/auth\/self-host\/config$/,
              },
            );
            yield* browser.use(`${title}: restore the viewport`, (current) =>
              previous === null ? Promise.resolve() : current.setViewportSize(previous),
            );
          }
      }),
    ),
  );
});
