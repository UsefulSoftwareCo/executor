import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Organization } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { batchedReads, batchPath, type BatchedRead } from "../support/read-batches.ts";

/** Reads mounted on every app tab; each one used to repeat every five seconds. */
const shared = ["app", "profiles", "inventory"] as const;
const tabs = [
  "Accounts",
  "Tools",
  "Skills",
  "Workflows",
  "Schedules",
  "Webhooks",
  "Settings",
  "Overview",
];
/** Simulated idle time, advanced with the browser's clock in small steps. */
const idleMinutes = 3;
const step = 10_000;
/** Freshness allows periodic reconciliation, but no more than one read per 20 seconds idle. */
const idleReadLimit = (idleMinutes * 60) / 20;

layer(HostedLive, { excludeTestServices: true })("Dashboard request volume", (it) => {
  it.effect(scenarios.dashboardRequestVolume.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Volume ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, mutation, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({ echo: mutation({ description: "Echo text", input: object({ text: string() }) },
    async (_, input) => input.text) })
}));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        // Reads may use the URL slug or the verified organization ID.
        const references = [actors.organization.slug, actors.organization.id];
        type Kind = (typeof shared)[number];
        const classify = (pathname: string): Kind | undefined => {
          for (const reference of references) {
            const base = `/api/organizations/${reference}`;
            if (pathname === `${base}/apps/${app.id}`) return "app";
            if (pathname === `${base}/apps/${app.id}/profiles`) return "profiles";
            if (pathname === `${base}/inventory`) return "inventory";
          }
          return undefined;
        };
        /** A batched read names its endpoint instead of a path. */
        const classifyRead = (read: BatchedRead): Kind | undefined => {
          if (read.group === "apps" && read.endpoint === "get" && read.params.app === app.id)
            return "app";
          if (read.group === "profiles" && read.endpoint === "list" && read.params.app === app.id)
            return "profiles";
          if (read.group === "organization" && read.endpoint === "inventory") return "inventory";
          return undefined;
        };
        const reads = { app: 0, profiles: 0, inventory: 0 };
        /** The shell's organization list; it is not polled, so it reads only on return. */
        let organizationLists = 0;
        let inFlight = 0;
        const observe = (page: Page) => {
          const tracked = new Set<unknown>();
          page.on("request", (request) => {
            const url = new URL(request.url());
            const organizationList =
              request.method() === "GET" && url.pathname === "/api/auth/organization/list";
            if (organizationList) organizationLists += 1;
            // The session's revalidation can start another organization list read after it ends.
            const shell =
              organizationList ||
              (request.method() === "GET" && url.pathname === "/api/auth/get-session");
            // The dashboard sends reads that start together as one batch; each counts as a read.
            const kinds: ReadonlyArray<Kind> =
              request.method() === "POST" && url.pathname === batchPath
                ? batchedReads(request.postData()).flatMap((read) => classifyRead(read) ?? [])
                : request.method() === "GET"
                  ? [classify(url.pathname)].flatMap((kind) => kind ?? [])
                  : [];
            if (kinds.length === 0 && !shell) return;
            for (const kind of kinds) reads[kind] += 1;
            inFlight += 1;
            tracked.add(request);
          });
          const settle = (request: unknown) => {
            if (tracked.delete(request)) inFlight -= 1;
          };
          page.on("requestfinished", settle);
          page.on("requestfailed", settle);
        };
        const measure = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const before = { ...reads };
            yield* effect;
            const counts = Object.fromEntries(
              shared.map((kind) => [kind, reads[kind] - before[kind]]),
            ) as Record<(typeof shared)[number], number>;
            yield* evidence.json(`reads-${name}.json`, counts);
            return counts;
          });
        /** Wait for an observed browser condition, bounded by the scenario deadline. */
        const until = (condition: () => boolean) =>
          Effect.suspend(() => (condition() ? Effect.void : Effect.fail("pending" as const))).pipe(
            Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
            Effect.orDie,
          );
        const settled = until(() => inFlight === 0);
        const idle = (label: string) =>
          Effect.forEach(
            Array.from({ length: (idleMinutes * 60_000) / step }),
            (_, index) =>
              browser
                .use(`${label}: advance ${((index + 1) * step) / 1000}s`, (page) =>
                  page.clock.runFor(step),
                )
                .pipe(Effect.andThen(settled)),
            { discard: true },
          );

        yield* browser.login(actors.owner);
        yield* browser.use("Control the browser clock and observe shared reads", (page) =>
          page.clock.install().then(() => observe(page)),
        );
        yield* openThroughBrowser(
          "Open the app overview",
          `/org/${actors.organization.slug}/apps/${app.id}?view=overview`,
        );
        yield* browser.use("The app overview has loaded", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .locator('[aria-current="page"]', { hasText: "Overview" })
            .waitFor({ state: "visible" }),
        );
        yield* settled;
        for (const kind of shared) expect(reads[kind], `initial ${kind} read`).toBeGreaterThan(0);

        const navigation = yield* measure(
          "tab-navigation",
          Effect.forEach(
            tabs,
            (tab) =>
              browser
                .use(`Open the ${tab} tab`, (page) =>
                  page
                    .getByRole("navigation", { name: "App navigation" })
                    .getByRole("link", { name: tab, exact: true })
                    .click(),
                )
                .pipe(
                  Effect.andThen(
                    browser.use(`The ${tab} tab is current`, (page) =>
                      page
                        .getByRole("navigation", { name: "App navigation" })
                        .locator('[aria-current="page"]', { hasText: tab })
                        .waitFor({ state: "visible" }),
                    ),
                  ),
                ),
            { discard: true },
          ).pipe(Effect.andThen(settled)),
        );
        // Switching tabs keeps the app page mounted; shared reads are not repeated per tab.
        for (const kind of shared)
          expect(navigation[kind], `${kind} during tab navigation`).toBe(0);

        const visible = yield* measure("visible-idle", idle("Visible idle"));
        for (const kind of shared) {
          expect(visible[kind], `${kind} reconciles while visible`).toBeGreaterThan(0);
          expect(visible[kind], `${kind} reads while visible`).toBeLessThanOrEqual(idleReadLimit);
        }

        yield* browser.use("Hide the page", (page) =>
          page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "hidden",
            });
            window.dispatchEvent(new Event("visibilitychange"));
          }),
        );
        const hidden = yield* measure("hidden-idle", idle("Hidden idle"));
        for (const kind of shared) expect(hidden[kind], `${kind} reads while hidden`).toBe(0);

        // Membership made elsewhere, such as in another tab, appears after the next return.
        // Self-host has a single organization, so only Cloud can gain one.
        const elsewhere =
          target.metadata.target === "cloud" ? `Elsewhere ${randomUUID().slice(0, 8)}` : undefined;
        if (elsewhere !== undefined) {
          const created = yield* body(
            Organization,
            yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
              name: elsewhere,
              slug: elsewhere.toLowerCase().replace(" ", "-"),
              keepCurrentActiveOrganization: true,
            }),
          );
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `/api/organizations/${created.id}`).pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
          );
        }

        // Returning to the tab reconciles every shared read once.
        const returned = yield* measure(
          "return",
          Effect.gen(function* () {
            const before = { ...reads };
            const listsBefore = organizationLists;
            yield* browser.use("Return to the page", (page) =>
              page.evaluate(() => {
                Reflect.deleteProperty(document, "visibilityState");
                window.dispatchEvent(new Event("visibilitychange"));
              }),
            );
            yield* until(() => shared.every((kind) => reads[kind] > before[kind]));
            yield* settled;
            yield* browser.use("Allow any follow-up read to start", (page) =>
              page.waitForTimeout(1_000),
            );
            yield* settled;
            // Revalidating the same session must not read the organizations a second time.
            yield* evidence.json("organization-lists-return.json", {
              reads: organizationLists - listsBefore,
            });
            expect(organizationLists - listsBefore, "organization lists after return").toBe(1);
          }),
        );
        for (const kind of shared) expect(returned[kind], `${kind} after return`).toBe(1);
        if (elsewhere !== undefined) {
          yield* browser.use("Open the organization switcher", (page) =>
            page.getByRole("button", { name: /^Organization: / }).click(),
          );
          yield* browser.use("The organization created elsewhere is listed", (page) =>
            page.getByRole("menuitemradio", { name: elsewhere, exact: true }).waitFor(),
          );
          yield* browser.checkpoint("Organization created elsewhere after one return");
          yield* browser.use("Close the organization switcher", (page) =>
            page.keyboard.press("Escape"),
          );
        }
        yield* browser.checkpoint("App page after idle windows");
      }),
    ),
  );
});
