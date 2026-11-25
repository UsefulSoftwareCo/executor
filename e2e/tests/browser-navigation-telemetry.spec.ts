import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

const STAY_MS = 3_000;
const SETTINGS_CHUNK = "**/org._organizationSlug.organization-*.js";
const GROUPS_CHUNK = "**/org._organizationSlug.groups.index-*.js";

layer(HostedLive, { excludeTestServices: true })("Browser navigation telemetry", (it) => {
  it.effect(scenarios.browserNavigationTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const apps = `/org/${actors.organization.slug}/apps`;
        const settings = `/org/${actors.organization.slug}/organization`;
        const groups = `/org/${actors.organization.slug}/groups`;
        const setVisibility = (state: "hidden" | "visible") =>
          browser.use(`Report the page ${state}`, (page) =>
            page.evaluate((value) => {
              Object.defineProperty(document, "visibilityState", {
                configurable: true,
                get: () => value,
              });
              document.dispatchEvent(new Event("visibilitychange"));
            }, state),
          );
        const hold = (name: string, chunk: string) =>
          Effect.gen(function* () {
            let requested = false;
            let release = () => {};
            const released = new Promise<void>((resolve) => {
              release = resolve;
            });
            yield* browser.use(`Hold the ${name} route's code`, (page) =>
              page.route(chunk, (route) => {
                requested = true;
                return released.then(() => route.continue());
              }),
            );
            yield* Effect.addFinalizer(() =>
              browser
                .use(`Release the ${name} route's code`, (page) => {
                  release();
                  return page.unroute(chunk);
                })
                .pipe(Effect.ignore),
            );
            return {
              release: () => release(),
              requested: Effect.suspend(() =>
                requested
                  ? Effect.void
                  : Effect.fail(new Error(`The ${name} route's code has not been requested`)),
              ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 })),
            };
          });
        const settingsCode = yield* hold("settings", SETTINGS_CHUNK);
        const groupsCode = yield* hold("groups", GROUPS_CHUNK);

        yield* browser.login(actors.owner);
        yield* browser.use("Load the apps page as a document", (page) => page.goto(apps));
        yield* browser.use("Confirm the apps page is rendered", (page) =>
          page.getByRole("link", { name: "Settings", exact: true }).waitFor(),
        );
        yield* browser.use("Stay on the first page", (page) => page.waitForTimeout(STAY_MS));

        yield* browser.use("Start navigating to settings", (page) =>
          page.getByRole("link", { name: "Settings", exact: true }).click(),
        );
        yield* settingsCode.requested;
        yield* setVisibility("hidden");
        yield* browser.use("Let settings resolve", (page) => {
          settingsCode.release();
          return page.getByRole("heading", { name: "Organization name", exact: true }).waitFor();
        });
        yield* setVisibility("visible");

        yield* browser.use("Navigate to apps", (page) =>
          Promise.all([
            page.waitForURL(`**${apps}`),
            page.getByRole("link", { name: "Apps", exact: true }).first().click(),
          ]),
        );
        yield* browser.use("Confirm apps is rendered", (page) =>
          page.getByRole("link", { name: "Settings", exact: true }).waitFor(),
        );

        yield* setVisibility("hidden");
        yield* browser.use("Navigate to settings while hidden", (page) =>
          Promise.all([
            page.waitForURL(`**${settings}`),
            page.getByRole("link", { name: "Settings", exact: true }).click(),
          ]),
        );
        yield* browser.use("Confirm settings is rendered again", (page) =>
          page.getByRole("heading", { name: "Organization name", exact: true }).waitFor(),
        );
        yield* setVisibility("visible");

        yield* browser.use("Start navigating to groups", (page) =>
          page.getByRole("link", { name: "Groups", exact: true }).first().click(),
        );
        yield* groupsCode.requested;
        yield* setVisibility("hidden");
        yield* setVisibility("visible");
        yield* browser.use("Navigate to apps before groups resolves", (page) =>
          Promise.all([
            page.waitForURL(`**${apps}`),
            page.getByRole("link", { name: "Apps", exact: true }).first().click(),
          ]),
        );
        yield* browser.use("Confirm apps is rendered again", (page) =>
          page.getByRole("link", { name: "Settings", exact: true }).waitFor(),
        );
        yield* setVisibility("hidden");

        const delivered = (path: string, count: number) =>
          telemetry.search("ui.navigation", { organizationPath: path }).pipe(
            Effect.flatMap((found) =>
              found.data.length >= count
                ? Effect.succeed(
                    found.data
                      .map(({ span }) => span)
                      .toSorted((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)),
                  )
                : Effect.fail(new Error(`Navigation spans for ${path} have not arrived`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
        const toSettings = yield* delivered(settings, 2);
        const toApps = yield* delivered(apps, 2);
        const toGroups = yield* delivered(groups, 1);
        yield* evidence.json("navigation-spans.json", { toSettings, toApps, toGroups });

        expect(toApps).toHaveLength(2);
        for (const span of toApps) {
          expect(span.tags["effect.fiber.interrupted"]).toBeUndefined();
          expect(span.tags["executor.navigation.hidden"]).toBe("false");
        }
        expect(toSettings).toHaveLength(2);
        for (const span of toSettings) {
          expect(span.tags["effect.fiber.interrupted"]).toBeUndefined();
          expect(span.tags["executor.navigation.hidden"]).toBe("true");
        }
        expect(toGroups).toHaveLength(1);
        expect(toGroups[0]!.tags["effect.fiber.interrupted"]).toBe("true");
        expect(toGroups[0]!.tags["executor.navigation.hidden"]).toBe("true");
      }),
    ),
  );
});
