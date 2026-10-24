import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Browser } from "../support/browser.ts";
import { holdQuery } from "../support/query-transition.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { enterClientDetails } from "../support/oauth-client-entry.ts";
import { officialApps } from "../support/public-catalogs.ts";
import { Target, driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const appRow = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
/** Where each row sits in the list, so a connection can be checked to move none of them. */
const rowBoxes = (page: Page) =>
  page
    .getByRole("region", { name: "Apps", exact: true })
    .getByRole("group")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const box = row.getBoundingClientRect();
        return { name: row.getAttribute("aria-label"), top: box.top, height: box.height };
      }),
    );
/** The list's last row: what to do about an app it does not show, without a link or button. */
const notListed = (page: Page) =>
  page.getByRole("region", { name: "Apps", exact: true }).evaluate((list) => {
    const last = list.lastElementChild;
    return {
      last: last?.getAttribute("role") === "note",
      text: last instanceof HTMLElement ? last.innerText : "",
      controls: last?.querySelectorAll("a, button, input").length ?? -1,
      rows: list.querySelectorAll("[role='group']").length,
    };
  });
const generalNote =
  "Not seeing what you’re looking for?\n\nOnce your assistant is connected, ask it to add any app or API through Executor.";
const searchNote = (query: string) =>
  `Not seeing “${query}”?\n\nOnce your assistant is connected, ask it to add “${query}” through Executor.`;
/** The label of the focused element, if any element other than the page has focus. */
const focused = (page: Page) =>
  page.evaluate(() =>
    document.activeElement === null || document.activeElement === document.body
      ? null
      : (document.activeElement.getAttribute("aria-label") ??
        document.activeElement.getAttribute("type")),
  );
/** Where an element sits on the page. */
const boxOf = (locator: ReturnType<Page["locator"]>) =>
  locator
    .boundingBox()
    .then((box) => box && { x: box.x, y: box.y, width: box.width, height: box.height });
const desktop = { width: 1440, height: 960 };

/** Connect one Synthetic Mail account with an API key and name it. */
const addMailToken = (page: Page, label: string) =>
  page
    .getByRole("dialog")
    .getByRole("textbox")
    .first()
    .fill(`synthetic-${label.toLowerCase().replaceAll(" ", "-")}`)
    .then(() => page.getByRole("dialog").getByRole("button", { name: "Connect account" }).click())
    .then(() => nameConnectedAccount(page, label));

layer(TestLive, { excludeTestServices: true })("Self-host onboarding", (it) => {
  it.effect(scenarios.selfHostOnboarding.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const origin = yield* startFreshSelfHost(target);
        yield* browser.use("Open first-run setup", (page) => page.goto(`${origin}/login`));
        yield* browser.use("Name the organization", (page) =>
          page.getByLabel("Organization name", { exact: true }).fill("Example Studio"),
        );
        yield* browser.use("Name the administrator", (page) =>
          page.getByLabel("Your name", { exact: true }).fill("Alex Example"),
        );
        yield* browser.use("Enter administrator email", (page) =>
          page.getByLabel("Email", { exact: true }).fill("alex@example.test"),
        );
        yield* browser.use("Enter administrator password", (page) =>
          page.getByLabel("Password", { exact: true }).fill("password"),
        );
        expect(
          yield* browser.use("An eight-character password can be submitted", (page) =>
            page
              .locator("form")
              .evaluate((form) => form instanceof HTMLFormElement && form.checkValidity()),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Administrator setup with an eight-character password");
        yield* browser.use("Create the administrator", (page) =>
          page.getByRole("button", { name: "Create administrator account", exact: true }).click(),
        );
        yield* browser.use("Administrator setup opens the organization's account step", (page) =>
          page.waitForURL(new RegExp(`^${origin}/org/[^/]+/setup/accounts$`, "u")),
        );
        const setup = yield* browser.use("Read the setup address", (page) =>
          Promise.resolve(new URL(page.url()).pathname.replace(/\/accounts$/u, "")),
        );
        yield* browser.use("The account step lists the catalog", (page) =>
          page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
        );
        expect(
          yield* browser.use("Onboarding stays outside the dashboard shell", (page) =>
            page.locator(".shell").count(),
          ),
        ).toBe(0);
        // Only apps that take an account are offered; the search counts them.
        expect(
          yield* browser.use("Read the listed apps", (page) =>
            Promise.all([
              page.getByRole("searchbox", { name: "Search apps" }).getAttribute("placeholder"),
              page.getByRole("region", { name: "Apps" }).getByRole("group").allInnerTexts(),
              // With nothing connected, the step's one forward button offers to skip, quietly.
              page.getByRole("link", { name: "Skip for now", exact: true }).isVisible(),
              page
                .getByRole("link", { name: "Skip for now", exact: true })
                .getAttribute("data-variant"),
              page.getByRole("link", { name: /^Continue/u }).count(),
            ]),
          ),
        ).toEqual([
          "Search 2 apps",
          [
            expect.stringContaining(officialApps.mail.name),
            expect.stringContaining(officialApps.tracker.name),
          ],
          true,
          "secondary",
          0,
        ]);
        expect(
          yield* browser.use("Each row offers its own way to connect", (page) =>
            Promise.all([
              appRow(page, officialApps.mail.name).getByRole("button").innerText(),
              appRow(page, officialApps.tracker.name).getByRole("button").innerText(),
            ]),
          ),
        ).toEqual(["Connect", "Connect"]);
        expect(
          yield* browser.use("The tracker restriction is visible before Connect", (page) =>
            appRow(page, officialApps.tracker.name).innerText(),
          ),
        ).toContain(officialApps.tracker.connectionNotices[0]?.message);
        // On a desktop the search has focus, so typing finds an app; the list ends with what to do
        // about an app it does not show.
        expect(yield* browser.use("The search has focus on a desktop", focused)).toBe(
          "Search apps",
        );
        expect(yield* browser.use("The list ends with a note", notListed)).toEqual({
          last: true,
          text: generalNote,
          controls: 0,
          rows: 2,
        });
        yield* browser.checkpoint("Connect your accounts");

        // Loading holds the list's place, so the actions stay put when the catalog arrives.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const catalog = yield* holdQuery(/\/catalog$/u, "continue");
            yield* browser.use("Reload the account step", (page) => page.reload());
            yield* catalog.requested;
            yield* browser.use("The list loads", (page) =>
              page.locator("[aria-label='Loading apps']").waitFor(),
            );
            const loading = yield* browser.use("Measure the actions while the list loads", (page) =>
              boxOf(page.getByRole("link", { name: "Skip for now", exact: true })),
            );
            yield* browser.checkpoint("The account step while its list loads");
            yield* catalog.release;
            yield* browser.use("The list has loaded", (page) =>
              page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
            );
            expect(
              yield* browser.use("Measure the actions once the list loads", (page) =>
                boxOf(page.getByRole("link", { name: "Skip for now", exact: true })),
              ),
            ).toEqual(loading);
          }),
        );
        // A search, too, keeps the list's height and so the actions' place.
        const actions = yield* browser.use("Measure the actions", (page) =>
          boxOf(page.getByRole("link", { name: "Skip for now", exact: true })),
        );
        yield* browser.use("Search for an app the catalog does not have", (page) =>
          page.getByRole("searchbox", { name: "Search apps" }).fill("Calendar"),
        );
        expect(yield* browser.use("With no match, the note is the whole list", notListed)).toEqual({
          last: true,
          text: searchNote("Calendar"),
          controls: 0,
          rows: 0,
        });
        expect(
          yield* browser.use("A search without a match keeps the actions in place", (page) =>
            boxOf(page.getByRole("link", { name: "Skip for now", exact: true })),
          ),
        ).toEqual(actions);
        yield* browser.checkpoint("A search with no match names it in the note");
        yield* browser.use("Clear the search for an app the catalog does not have", (page) =>
          page.getByRole("button", { name: "Clear search", exact: true }).click(),
        );

        // On a phone the keyboard would cover the list, so nothing takes focus.
        yield* browser.use("Use a phone viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.use("Reload the account step on a phone", (page) => page.reload());
        yield* browser.use("The list loads on a phone", (page) =>
          page.getByRole("region", { name: "Apps", exact: true }).waitFor(),
        );
        expect(yield* browser.use("Nothing has focus on a phone", focused)).toBe(null);
        expect(yield* browser.use("The list ends with a note on a phone", notListed)).toEqual({
          last: true,
          text: generalNote,
          controls: 0,
          rows: 2,
        });
        yield* browser.checkpoint("Connect your accounts on a phone, before a search");
        yield* browser.use("Restore the desktop viewport", (page) => page.setViewportSize(desktop));

        // Search filters the list in place, without leaving setup.
        yield* browser.use("Search for the tracker", (page) =>
          page.getByRole("searchbox", { name: "Search apps" }).fill("track"),
        );
        yield* browser.use("Only the tracker matches", (page) =>
          page.getByText("1 app match “track”", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The mail app is filtered out", (page) =>
            appRow(page, officialApps.mail.name).count(),
          ),
        ).toBe(0);
        expect(yield* browser.use("The note after the match names the search", notListed)).toEqual({
          last: true,
          text: searchNote("track"),
          controls: 0,
          rows: 1,
        });
        yield* browser.checkpoint("Search apps in place");
        yield* browser.use("Clear the search", (page) =>
          page.getByRole("button", { name: "Clear search", exact: true }).click(),
        );

        // Connecting installs the app, runs its own connection form, then names the account.
        // Only the row's detail and button change: no row moves or grows.
        const before = yield* browser.use("Measure the rows", rowBoxes);
        const forwardBox = (name: string) =>
          browser.use(`Measure ${name}`, (page) =>
            page
              .getByRole("link", { name, exact: true })
              .boundingBox()
              .then((box) => box && { x: box.x, width: box.width, height: box.height }),
          );
        const skipBox = yield* forwardBox("Skip for now");
        yield* browser.use("Add a Synthetic Mail token", (page) =>
          appRow(page, officialApps.mail.name).getByRole("button", { name: "Connect" }).click(),
        );
        yield* browser.use("The app's connection form opens", (page) =>
          page.getByRole("dialog", { name: `Connect ${officialApps.mail.name}` }).waitFor(),
        );
        // The form opens on its first field, not on the hint beside the field's label.
        expect(
          yield* browser.use("The first field has focus and no hint is open", (page) =>
            Promise.all([
              page
                .getByRole("dialog")
                .getByRole("textbox")
                .first()
                .evaluate((field) => field === document.activeElement),
              page.getByRole("tooltip").count(),
            ]),
          ),
        ).toEqual([true, 0]);
        yield* browser.checkpoint("Add a token for an app");
        yield* browser.use("Save and name the first account", (page) =>
          addMailToken(page, "Work mail"),
        );
        yield* browser.use("The row shows the connected account", (page) =>
          appRow(page, officialApps.mail.name).getByText("Work mail", { exact: true }).waitFor(),
        );
        expect(yield* browser.use("Measure the rows again", rowBoxes)).toEqual(before);
        expect(
          yield* browser.use("The row offers another account and Continue replaces Skip", (page) =>
            Promise.all([
              appRow(page, officialApps.mail.name).getByRole("button").innerText(),
              page.getByRole("link", { name: "Continue with 1 account", exact: true }).isVisible(),
              page
                .getByRole("link", { name: "Continue with 1 account", exact: true })
                .getAttribute("data-variant"),
              page.getByRole("link", { name: "Skip for now", exact: true }).count(),
            ]),
          ),
        ).toEqual(["Add another +", true, "default", 0]);
        // The button changes its label and style in place.
        expect(yield* forwardBox("Continue with 1 account")).toEqual(skipBox);
        yield* browser.checkpoint("Continue replaces Skip for now");
        // On a short screen the list scrolls. Connecting from a row it shows only in part, then
        // closing the dialogs, leaves the list where it was rather than scrolling the row into view.
        yield* browser.use("Use a short phone viewport", (page) =>
          page.setViewportSize({ width: 375, height: 600 }),
        );
        const scrolled = yield* browser.use(
          "Scroll the list past the top of the first row",
          (page) =>
            page.getByRole("region", { name: "Apps", exact: true }).evaluate((list) => {
              list.scrollTop = 12;
              return list.scrollTop;
            }),
        );
        expect(scrolled).toBe(12);
        // Phones shorten the button to "Add +". It is pressed where it is, as a pointer would: the
        // driver's own click first scrolls its target fully into view, which would hide the result.
        yield* browser.use("Add another Synthetic Mail account", (page) =>
          appRow(page, officialApps.mail.name)
            .getByRole("button", { name: "Add +", exact: true })
            .evaluate((button) => {
              if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
              button.focus({ preventScroll: true });
              button.click();
            }),
        );
        yield* browser.use("Save and name the second account", (page) =>
          addMailToken(page, "Personal mail"),
        );
        expect(
          yield* browser.use("The list has not scrolled", (page) =>
            page
              .getByRole("region", { name: "Apps", exact: true })
              .evaluate((list) => list.scrollTop),
          ),
        ).toBe(scrolled);
        yield* browser.use("Restore the desktop viewport after the short phone", (page) =>
          page.setViewportSize(desktop),
        );
        yield* browser.use("The row counts the second account", (page) =>
          page
            .getByRole("button", { name: `Show all 2 ${officialApps.mail.name} accounts` })
            .waitFor(),
        );
        expect(yield* browser.use("The second account moves no row", rowBoxes)).toEqual(before);
        yield* browser.use("Open every mail account", (page) =>
          page
            .getByRole("button", { name: `Show all 2 ${officialApps.mail.name} accounts` })
            .click(),
        );
        expect(
          yield* browser.use("The popover lists both accounts", (page) =>
            page
              .getByRole("list", { name: `${officialApps.mail.name} accounts` })
              .getByRole("listitem")
              .allInnerTexts(),
          ),
        ).toEqual([expect.stringContaining("Work mail"), expect.stringContaining("Personal mail")]);
        yield* browser.checkpoint("Every account of an app opens over the list");
        yield* browser.use("Close the accounts popover", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Use a phone viewport for the account step", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Connect your accounts on a phone");
        yield* browser.use("Restore desktop viewport for the account step", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );

        // An OAuth sign-in started here returns here, even when the service cancels it.
        yield* browser.use("Connect the tracker with OAuth", (page) =>
          appRow(page, officialApps.tracker.name).getByRole("button", { name: "Connect" }).click(),
        );
        expect(
          yield* browser.use("The tracker restriction remains before OAuth setup", (page) =>
            page
              .getByRole("dialog", { name: `Connect ${officialApps.tracker.name}` })
              .getByRole("note", { name: `${officialApps.tracker.name} connection notices` })
              .innerText(),
          ),
        ).toContain(officialApps.tracker.connectionNotices[0]?.message);
        yield* browser.use("Enter OAuth client details", enterClientDetails);
        yield* browser.use("Provide a synthetic public client", (page) =>
          page.getByRole("textbox", { name: "Client ID", exact: true }).fill("synthetic-client"),
        );
        yield* browser.use("The service cancels consent", (page) =>
          page.route("https://tracker.example.test/oauth/authorize**", (route) => {
            const authorization = new URL(route.request().url());
            // RFC 6749 §3.1.2: the redirect URI's own query survives an error response too.
            const denied = new URL(authorization.searchParams.get("redirect_uri") ?? origin);
            denied.searchParams.set("error", "access_denied");
            denied.searchParams.set("state", authorization.searchParams.get("state") ?? "");
            const callback = new URL("/oauth/callback", origin);
            callback.search = denied.search;
            return route.fulfill({ status: 302, headers: { location: callback.href } });
          }),
        );
        yield* browser.use("Start the tracker sign-in", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: `Connect ${officialApps.tracker.name}`, exact: true })
            .click(),
        );
        yield* browser.use("The callback offers a way back to setup", (page) =>
          page.getByRole("heading", { name: "Connection cancelled", exact: true }).waitFor(),
        );
        yield* browser.use("Return to setup", (page) =>
          page.getByRole("link", { name: "Back to setup", exact: true }).click(),
        );
        yield* browser.use("The account step reopens with its accounts", (page) =>
          page
            .waitForURL(`${origin}${setup}/accounts`)
            .then(() => page.getByRole("link", { name: "Continue with 2 accounts" }).waitFor()),
        );
        yield* browser.use("Continue with the connected accounts", (page) =>
          page.getByRole("link", { name: "Continue with 2 accounts" }).click(),
        );
        yield* browser.use("Accounts continue to the agent handoff", (page) =>
          page.waitForURL(`${origin}${setup}/assistant`),
        );
        yield* browser.use("The assistant choices are visible", (page) =>
          page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
        );
        yield* browser.use("Reload the handoff", (page) => page.reload());
        yield* browser.use("Reload retains the assistant choices", (page) =>
          page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Self-host administrator agent handoff");
        yield* browser.use("Use a phone viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Self-host agent handoff on mobile");
        yield* browser.use("Restore desktop viewport", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* browser.use("Allow clipboard access", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );
        yield* browser.use("Copy the instance MCP URL for any client", (page) =>
          page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the MCP URL copied from the assistants", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`${origin}/mcp`);
        yield* browser.use("Choose Claude", (page) =>
          page.getByRole("button", { name: "Claude", exact: true }).click(),
        );
        yield* browser.use("Claude's guide replaces the choices", (page) =>
          page.getByRole("heading", { name: "Add Executor to Claude", exact: true }).waitFor(),
        );
        yield* browser.use("Copy the instance MCP URL", (page) =>
          page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied MCP URL", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(`${origin}/mcp`);
        yield* browser.use("Setup waits for Claude", (page) =>
          page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
        );
        // The assistant signs in from its own tab, so agent setup keeps its state.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* browser.omitNetworkTrace;
            const tab = yield* Effect.acquireRelease(
              browser.use("Open the assistant's sign-in tab", (page) => page.context().newPage()),
              (tab) =>
                driver("Close the assistant's sign-in tab", () => tab.close()).pipe(Effect.orDie),
            );
            yield* authorizeBrowserMcp(tab, origin, { client: "Self-host assistant" });
            yield* browser.use("Return to agent setup", (page) => page.bringToFront());
          }),
        );
        yield* browser.use("The new agent is detected", (page) =>
          page.getByText("Approved for Self-host assistant", { exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Claude connected in the self-host handoff");
        yield* browser.use("Continue to the first prompt", (page) =>
          page.getByRole("link", { name: "Next: first prompt", exact: true }).click(),
        );
        yield* browser.checkpoint("First prompt names the connected accounts");
        yield* browser.use("Copy the starter prompt", (page) =>
          page.getByRole("button", { name: "Copy starter prompt", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the copied prompt", (page) =>
            page.evaluate(() => navigator.clipboard.readText()),
          ),
        ).toBe(
          `Use Executor, which I connected over MCP at ${origin}/mcp. If you cannot see its tools yet, connect to that server first.\n\nI've connected ${officialApps.mail.name} (Work mail and Personal mail). Read the docs to understand the product at https://executor.sh/docs/, then show me what you can do with them.`,
        );
        yield* browser.use("Open the dashboard when ready", (page) =>
          page.getByRole("link", { name: "Open dashboard", exact: false }).click(),
        );
        yield* browser.use("The new organization opens Apps", (page) =>
          page.waitForURL(`${origin}/org/*/apps`),
        );
        const dashboard = yield* browser.use("Remember the organization destination", (page) =>
          Promise.resolve(page.url()),
        );
        yield* browser.use("Open the account menu", (page) =>
          page.getByRole("button", { name: /^Account: / }).click(),
        );
        yield* browser.use("Sign out", (page) =>
          page.getByRole("menuitem", { name: "Sign out", exact: true }).click(),
        );
        yield* browser.use("Enter returning administrator email", (page) =>
          page.getByLabel("Email", { exact: true }).fill("alex@example.test"),
        );
        yield* browser.use("Enter returning administrator password", (page) =>
          page.getByLabel("Password", { exact: true }).fill("password"),
        );
        yield* browser.use("Sign in again", (page) =>
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        );
        yield* browser.use("Returning sign-in opens the existing dashboard", (page) =>
          page.waitForURL(dashboard),
        );
      }),
    ),
  );
});
