/** Cloud offers a support dialog from every sidebar layout; self-host has none. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { analyticsEvents } from "../support/collector-events.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const channels = {
  Discord: "https://discord.gg/eF29HBHwM6",
  "GitHub Issues": "https://github.com/UsefulSoftwareCo/executor/issues",
  Email: "mailto:rhys@executor.sh?subject=Executor%20support",
} as const;

const supportDialog = (page: Page) => page.getByRole("dialog", { name: "Get support" });
const rail = (page: Page) => page.locator("aside.sidebar");

layer(HostedLive, { excludeTestServices: true })("Support dialog", (it) => {
  it.effect(scenarios.supportDialog.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          api = yield* Api,
          target = yield* Target;
        const cloud = target.metadata.target === "cloud";
        yield* browser.login(actors.owner);
        yield* browser.use("Open the dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Wait for apps", (page) =>
          page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor(),
        );
        // The Feedback resource link is unchanged on every hosted product.
        expect(
          yield* browser.use("Read the Feedback link", (page) =>
            rail(page).getByRole("link", { name: "Feedback" }).getAttribute("href"),
          ),
        ).toBe(channels["GitHub Issues"]);

        if (!cloud) {
          expect(
            yield* browser.use("Check the rail has no support entry", (page) =>
              page.getByRole("button", { name: "Get support" }).count(),
            ),
          ).toBe(0);
          yield* browser.use("Use a phone viewport", (page) =>
            page
              .setViewportSize({ width: 390, height: 844 })
              .then(() => page.getByRole("button", { name: "Menu", exact: true }).click())
              .then(() => page.getByRole("dialog", { name: "Menu" }).waitFor()),
          );
          expect(
            yield* browser.use("Check the phone menu has no support entry", (page) =>
              page.getByRole("dialog", { name: "Menu" }).getByText("Get support").count(),
            ),
          ).toBe(0);
          return;
        }

        // Other cases share the Worker and its collector; browser events carry this actor's identity.
        const owner = yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        const supportEvents = analyticsEvents({ person: owner.user.id }).pipe(
          Effect.map((events) =>
            events.filter(
              (event) => event.event === "support_opened" || event.event === "support_link_clicked",
            ),
          ),
        );
        const before = (yield* supportEvents).length;
        const waitForEvents = (count: number) =>
          supportEvents.pipe(
            Effect.map((events) => events.slice(before)),
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (events) => events.length >= count,
            }),
            Effect.timeout("10 seconds"),
          );

        const checkDialog = Effect.gen(function* () {
          yield* browser.use("Wait for the support dialog", (page) =>
            supportDialog(page).waitFor(),
          );
          expect(
            yield* browser.use("Read the support dialog", (page) =>
              supportDialog(page).innerText(),
            ),
          ).toContain("Reach out through any of the channels below.");
          for (const [label, href] of Object.entries(channels))
            expect(
              yield* browser.use(`Read the ${label} channel`, (page) =>
                supportDialog(page)
                  .getByRole("link", { name: label, exact: true })
                  .getAttribute("href"),
              ),
            ).toBe(href);
        });
        // Dialogs animate in; the checkpoint waits for the open dialog's own animations.
        const settle = (name: string, dialog = "Get support") =>
          browser
            .use(`Let ${name} finish animating`, (page) =>
              page.getByRole("dialog", { name: dialog }).evaluate((element) =>
                Promise.all(
                  // A cancelled transition, such as a hover change, is no longer running.
                  element
                    .getAnimations({ subtree: true })
                    .map((animation) => animation.finished.catch(() => undefined)),
                ).then(() => undefined),
              ),
            )
            .pipe(Effect.andThen(browser.checkpoint(name)));
        const closeDialog = browser.use("Close the support dialog", (page) =>
          page.keyboard
            .press("Escape")
            .then(() => supportDialog(page).waitFor({ state: "hidden" })),
        );

        // Wide rail.
        yield* browser.checkpoint("Wide rail with Get support");
        yield* browser.use("Open support from the wide rail", (page) =>
          rail(page).getByRole("button", { name: "Get support" }).click(),
        );
        yield* checkDialog;
        yield* settle("Wide rail support dialog");
        const slack = (page: Page) =>
          supportDialog(page).getByRole("button", { name: "Slack Connect" });
        const slackInstructions = (page: Page) =>
          supportDialog(page).getByText("Invite rhys@executor.sh to Slack Connect.", {
            exact: true,
          });
        expect(
          yield* browser.use("Check Slack Connect starts collapsed", (page) =>
            Promise.all([
              slack(page).getAttribute("aria-expanded"),
              slackInstructions(page).count(),
            ]),
          ),
        ).toEqual(["false", 0]);
        yield* browser.use("Show Slack Connect instructions", (page) =>
          slack(page)
            .click()
            .then(() => slackInstructions(page).waitFor()),
        );
        expect(
          yield* browser.use("Check Slack Connect is expanded", (page) =>
            slack(page).getAttribute("aria-expanded"),
          ),
        ).toBe("true");
        yield* settle("Slack Connect instructions");
        yield* browser.use("Hide Slack Connect instructions", (page) =>
          slack(page)
            .click()
            .then(() => slackInstructions(page).waitFor({ state: "hidden" })),
        );
        // External channels open in a new tab; the browser serves them without leaving the test machine.
        yield* browser.use("Serve external channels locally", (page) =>
          Promise.all(
            ["https://discord.gg/**", "https://github.com/**"].map((pattern) =>
              page
                .context()
                .route(pattern, (route) =>
                  route.fulfill({ contentType: "text/html", body: "<title>Channel</title>" }),
                ),
            ),
          ),
        );
        for (const label of ["Discord", "GitHub Issues"] as const)
          expect(
            yield* browser.use(`Follow the ${label} channel`, (page) =>
              Promise.all([
                page.waitForEvent("popup"),
                supportDialog(page).getByRole("link", { name: label, exact: true }).click(),
              ]).then(([popup]) => {
                const url = popup.url();
                return popup.close().then(() => url);
              }),
            ),
          ).toBe(channels[label]);
        const events = yield* waitForEvents(3);
        expect(events.map((event) => event.event)).toEqual([
          "support_opened",
          "support_link_clicked",
          "support_link_clicked",
        ]);
        expect(events[0]?.properties).toMatchObject({ page: "apps", executor_test: true });
        expect(events[1]?.properties).toMatchObject({ label: "Discord", page: "apps" });
        expect(events[2]?.properties).toMatchObject({ label: "GitHub Issues", page: "apps" });
        yield* closeDialog;

        yield* browser.use("Use dark mode", (page) => page.emulateMedia({ colorScheme: "dark" }));
        yield* browser.checkpoint("Wide rail with Get support, dark");
        yield* browser.use("Open support in dark mode", (page) =>
          rail(page).getByRole("button", { name: "Get support" }).click(),
        );
        yield* checkDialog;
        yield* settle("Wide rail support dialog, dark");
        yield* closeDialog;

        // Collapsed rail: an icon-only entry with the same accessible name.
        yield* browser.use("Use a medium viewport", (page) =>
          page
            .setViewportSize({ width: 900, height: 900 })
            .then(() => page.getByRole("button", { name: "Expand sidebar" }).waitFor()),
        );
        const collapsed = yield* browser.use("Measure the collapsed support entry", (page) =>
          rail(page)
            .getByRole("button", { name: "Get support" })
            .evaluate((button) => ({
              width: button.getBoundingClientRect().width,
              rail: button.closest("aside")?.getBoundingClientRect().width ?? 0,
              label: button.querySelector("span")?.getBoundingClientRect().width ?? -1,
            })),
        );
        expect(collapsed.rail).toBe(60);
        expect(collapsed.label).toBe(0);
        expect(collapsed.width).toBeGreaterThan(30);
        yield* browser.checkpoint("Collapsed rail with Get support, dark");
        yield* browser.use("Open support from the dark collapsed rail", (page) =>
          rail(page).getByRole("button", { name: "Get support" }).click(),
        );
        yield* checkDialog;
        yield* settle("Collapsed rail support dialog, dark");
        yield* closeDialog;
        yield* browser.use("Use light mode", (page) => page.emulateMedia({ colorScheme: "light" }));
        yield* browser.checkpoint("Collapsed rail with Get support");
        yield* browser.use("Open support from the collapsed rail", (page) =>
          rail(page).getByRole("button", { name: "Get support" }).click(),
        );
        yield* checkDialog;
        yield* settle("Collapsed rail support dialog");
        yield* closeDialog;

        // Phone: the entry lives in the Menu sheet.
        yield* browser.use("Use a phone viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        for (const scheme of ["light", "dark"] as const) {
          const suffix = scheme === "dark" ? ", dark" : "";
          yield* browser.use(`Use ${scheme} mode`, (page) =>
            page.emulateMedia({ colorScheme: scheme }),
          );
          yield* browser.use("Open the phone menu", (page) =>
            page
              .getByRole("button", { name: "Menu", exact: true })
              .click()
              .then(() => page.getByRole("dialog", { name: "Menu" }).waitFor()),
          );
          yield* settle(`Phone menu with Get support${suffix}`, "Menu");
          yield* browser.use("Open support from the phone menu", (page) =>
            page
              .getByRole("dialog", { name: "Menu" })
              .getByRole("button", { name: "Get support" })
              .click(),
          );
          yield* checkDialog;
          yield* settle(`Phone support dialog${suffix}`);
          yield* closeDialog;
          yield* browser.use("Close the phone menu", (page) =>
            page.keyboard
              .press("Escape")
              .then(() => page.getByRole("dialog", { name: "Menu" }).waitFor({ state: "hidden" })),
          );
        }
        // Every open was recorded, without a link click for the dialogs that were only read.
        const all = yield* waitForEvents(8);
        expect(all.filter((event) => event.event === "support_opened")).toHaveLength(6);
        expect(all.filter((event) => event.event === "support_link_clicked")).toHaveLength(2);
      }),
    ),
  );
});
