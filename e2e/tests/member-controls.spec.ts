import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
/** Members keep a stable app overview and discover restricted actions without gaining authority. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const Access = Schema.Struct({ revision: Schema.String });
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const source = `import { defineApp, defineProvider, secrets, query, object, string } from "apps";
const service = defineProvider({name:"Member controls fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:service.many()}},{queries:{hello:query({input:object({})},async()=>"Hello")}});`;
const bounds = (page: Page) =>
  page.locator(".app-overview > div > section").evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );

layer(HostedLive, { excludeTestServices: true })("Member controls", (it) => {
  for (const [scenario, width] of [
    [scenarios.memberControls, 1440],
    [scenarios.memberControlsMobile, 390],
  ] as const)
    it.effect(scenario.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const name = `Member controls ${randomUUID().slice(0, 8)}`;
          const app = yield* body(
            App,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: [{ path: "index.ts", content: source }],
            }),
          );
          const accounts: string[] = [],
            groups: Array<typeof Group.Type> = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
              ).toBe(200);
              for (const id of accounts)
                expect(
                  (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`)).status,
                ).toBe(200);
              for (const group of groups)
                expect(
                  (yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
                    revision: group.revision,
                  })).status,
                ).toBe(200);
            }).pipe(Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
              destination: { kind: "shared", audience: { kind: "everyone" } },
            }),
          );
          const account = yield* body(
            Resource,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              {
                method: "key",
                label: name,
                fields: { token: "synthetic" },
              },
            ),
          );
          accounts.push(account.id);
          const access = yield* body(
            Access,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
              revision: access.revision,
              audience: { kind: "everyone" },
            })).status,
          ).toBe(200);
          const memberProfile = yield* createProfile(actors.member, `${prefix}/apps/${app.id}`);
          expect(
            (yield* selectProfileAccounts(
              actors.member,
              `${prefix}/apps/${app.id}`,
              memberProfile.id,
              { service: [account.id] },
            )).status,
          ).toBe(200);
          const viewer = yield* body(
            Schema.Struct({ userId: Schema.String }),
            yield* api.request(actors.member, "GET", "/api/viewer"),
          );
          const directory = yield* body(
            Schema.Struct({
              members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
            }),
            yield* api.request(actors.owner, "GET", `${prefix}/groups`),
          );
          const member = directory.members.find((entry) => entry.userId === viewer.userId);
          if (!member) throw new Error("Synthetic member missing");
          const group = yield* body(
            Group,
            yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
              name,
              description: "",
              memberIds: [member.id],
            }),
          );
          groups.push(group);
          const url = `/org/${actors.organization.slug}/apps/${app.id}`;
          yield* browser.login(actors.member);
          const forbiddenReads: string[] = [];
          yield* browser.use("Record source requests without inspecting their contents", (page) =>
            page.route(
              (url) =>
                url.pathname.includes(`/apps/${app.id}/`) &&
                /\/(source|workspace|history|deployments)$/.test(url.pathname),
              (route) => {
                forbiddenReads.push(new URL(route.request().url()).pathname);
                return route.fallback();
              },
            ),
          );
          {
            yield* browser.use("Set member viewport", (page) =>
              page.setViewportSize({ width, height: 900 }),
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const references = [actors.organization.slug, actors.organization.id];
                const authority = yield* holdQuery(
                  references.map((ref) => `/api/organizations/${ref}/apps/${app.id}/access`),
                  "continue",
                  { allRequests: true },
                );
                const inventory = yield* holdQuery(
                  references.map((ref) => `/api/organizations/${ref}/inventory`),
                  "continue",
                  { allRequests: true },
                );
                yield* browser.use("Open member overview before permissions resolve", (page) =>
                  page.goto(`${url}?view=overview`),
                );
                yield* authority.requested;
                yield* inventory.requested;
                yield* browser.use("App metadata loads independently", (page) =>
                  page.getByRole("heading", { name: `${name} overview`, exact: true }).waitFor(),
                );
                yield* browser.use("Overview is pending", (page) =>
                  page.getByRole("status", { name: "Loading overview", exact: true }).waitFor(),
                );
                const initial = yield* browser.use("Measure overview before permissions", bounds);
                expect(initial).toHaveLength(5);
                const sourceHeader = yield* browser.use(
                  "Measure pending source card header",
                  (page) =>
                    page
                      .locator(".app-overview > div > section:last-child > div:first-child")
                      .boundingBox(),
                );
                expect(sourceHeader).not.toBeNull();
                expect(
                  yield* browser.use("Source stays present while permissions load", (page) =>
                    page
                      .getByRole("navigation", { name: "App navigation" })
                      .getByRole("button", { name: "Source", exact: true })
                      .count(),
                  ),
                ).toBe(1);
                yield* browser.checkpoint(`${width} member permissions pending`);
                yield* authority.release;
                yield* browser.use("Member restriction resolves", (page) =>
                  page
                    .locator(
                      '[data-disabled-reason="Only the app creator and organization admins can view app source and deployments."]',
                    )
                    .first()
                    .waitFor(),
                );
                expect(
                  yield* browser.use("Permission resolution preserves overview cards", bounds),
                ).toEqual(initial);
                yield* browser.checkpoint(`${width} member inventory pending`);
                yield* inventory.release;
                yield* browser.use("Restricted source card is loaded", (page) =>
                  page.getByRole("region", { name: "App source", exact: true }).waitFor(),
                );
                yield* browser.use("Every overview preview finishes loading", (page) =>
                  page
                    .locator('.app-overview [data-slot="skeleton"]')
                    .first()
                    .waitFor({ state: "hidden" }),
                );
                const loaded = yield* browser.use("Measure loaded member cards", bounds);
                expect(loaded).toHaveLength(5);
                expect(
                  yield* browser.use("Source card header stays in place", (page) =>
                    page
                      .locator(".app-overview > div > section:last-child > div:first-child")
                      .boundingBox(),
                  ),
                ).toEqual(sourceHeader);
                loaded.forEach((card, index) => {
                  const before = initial[index];
                  if (!before) throw new Error("Missing pending card");
                  for (const coordinate of ["x", "y", "width", "height"] as const)
                    expect(Math.abs(card[coordinate] - before[coordinate])).toBeLessThanOrEqual(2);
                });
                expect(
                  yield* browser.use("Source tab is disabled", (page) =>
                    page
                      .getByRole("navigation", { name: "App navigation" })
                      .getByRole("button", { name: "Source", exact: true })
                      .isDisabled(),
                  ),
                ).toBe(true);
                expect(
                  yield* browser.use("Deployments tab is disabled", (page) =>
                    page
                      .getByRole("navigation", { name: "App navigation" })
                      .getByRole("button", { name: "Deployments", exact: true })
                      .isDisabled(),
                  ),
                ).toBe(true);
                expect(
                  yield* browser.use("Source preview link is disabled", (page) =>
                    page.getByRole("link", { name: "View files", exact: true }).isDisabled(),
                  ),
                ).toBe(true);
                yield* browser.checkpoint(`${width} member overview loaded`);
                yield* browser.use("Focus the disabled source explanation", (page) =>
                  page
                    .getByRole("navigation", { name: "App navigation" })
                    .getByRole("button", { name: "Source", exact: true })
                    .locator("..")
                    .focus(),
                );
                yield* browser.use("Keyboard users receive the reason", (page) =>
                  page
                    .locator('[role="tooltip"]:not([data-state="closed"])')
                    .filter({ hasText: "Only the app creator and organization admins" })
                    .waitFor(),
                );
                yield* browser.checkpoint(`${width} source restriction tooltip`);
                yield* browser.use("Enter cannot navigate through a disabled tab", (page) =>
                  page.keyboard.press("Enter"),
                );
                expect(
                  yield* browser.use("Still on overview", (page) =>
                    page.evaluate(() => new URL(window.location.href).searchParams.get("view")),
                  ),
                ).toBe("overview");
                yield* browser.use("Dismiss tooltip", (page) => page.keyboard.press("Escape"));
                yield* browser.use("Hover the disabled source preview", (page) =>
                  page.getByRole("link", { name: "View files", exact: true }).locator("..").hover(),
                );
                yield* browser.use("Hover explains the disabled link", (page) =>
                  page
                    .locator('[role="tooltip"]:not([data-state="closed"])')
                    .filter({ hasText: "Only the app creator and organization admins" })
                    .waitFor(),
                );
                yield* browser.use("Move off the disabled preview", (page) =>
                  page.mouse.move(0, 0),
                );
                yield* browser.use("Dismiss hover explanation", (page) =>
                  page.keyboard.press("Escape"),
                );
                yield* browser.use("Tap the disabled source preview", (page) =>
                  page.getByRole("link", { name: "View files", exact: true }).locator("..").click(),
                );
                yield* browser.use("Tap opens the explanation", (page) =>
                  page
                    .locator('[role="tooltip"]:not([data-state="closed"])')
                    .filter({ hasText: "Only the app creator and organization admins" })
                    .waitFor(),
                );
                expect(
                  yield* browser.use("Disabled preview never navigates", (page) =>
                    page.evaluate(() => new URL(window.location.href).searchParams.get("view")),
                  ),
                ).toBe("overview");
                yield* browser.use("Dismiss preview tooltip", (page) =>
                  page.keyboard.press("Escape"),
                );
                expect(
                  yield* browser.use("Member overview fits viewport", (page) =>
                    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                  ),
                ).toBe(true);
              }),
            );
            yield* browser.use("Open member app settings", (page) =>
              page.goto(`${url}?view=settings`),
            );
            for (const label of [
              "Rename",
              "Make a copy",
              "Delete app",
              "Save access",
              "Reset changes",
              "Publish",
            ])
              expect(
                yield* browser.use(`Restricted ${label} remains visible`, (page) =>
                  page.getByRole("button", { name: label, exact: true }).isDisabled(),
                ),
              ).toBe(true);
            expect(
              yield* browser.use("Sharing selector remains disabled", (page) =>
                page.getByRole("combobox", { name: "Who can use this app?" }).isDisabled(),
              ),
            ).toBe(true);
            yield* browser.checkpoint(`${width} member settings`);
            for (const tab of ["skills", "schedules"] as const) {
              yield* browser.use(`Open member ${tab}`, (page) => page.goto(`${url}?view=${tab}`));
              expect(
                yield* browser.use(`Restricted ${tab} action stays disabled`, (page) =>
                  tab === "skills"
                    ? page.getByRole("button", { name: "Copy prompt", exact: true }).isDisabled()
                    : page.getByRole("link", { name: "Open source", exact: true }).isDisabled(),
                ),
              ).toBe(true);
            }
            yield* browser.use("Open shared account", (page) =>
              page.goto(`/org/${actors.organization.slug}/accounts/${account.id}`),
            );
            for (const label of ["Save name", "Update credentials", "Save access", "Reset changes"])
              expect(
                yield* browser.use(`Account ${label} is disabled`, (page) =>
                  page.getByRole("button", { name: label, exact: true }).isDisabled(),
                ),
              ).toBe(true);
            expect(
              yield* browser.use("Delete account is disabled", (page) =>
                page.getByRole("link", { name: "Delete account", exact: true }).isDisabled(),
              ),
            ).toBe(true);
            expect(
              yield* browser.use("Account name remains visible and disabled", (page) =>
                page.getByRole("textbox", { name: "Account name", exact: true }).isDisabled(),
              ),
            ).toBe(true);
            yield* browser.checkpoint(`${width} member shared account`);
            yield* browser.use("Open member group", (page) =>
              page.goto(`/org/${actors.organization.slug}/groups/${group.id}`),
            );
            for (const label of ["Edit group", "Delete group"])
              expect(
                yield* browser.use(`Group ${label} is disabled`, (page) =>
                  page.getByRole("button", { name: label, exact: true }).isDisabled(),
                ),
              ).toBe(true);
            yield* browser.use("Open member organization settings", (page) =>
              page.goto(`/org/${actors.organization.slug}/organization`),
            );
            expect(
              yield* browser.use("Organization name is disabled", (page) =>
                page.getByRole("textbox", { name: "Organization name", exact: true }).isDisabled(),
              ),
            ).toBe(true);
            expect(
              yield* browser.use("Inviting members is disabled", (page) =>
                page.getByRole("button", { name: "Add member", exact: true }).isDisabled(),
              ),
            ).toBe(true);
            yield* browser.checkpoint(`${width} member organization settings`);
          }
          expect(forbiddenReads).toEqual([]);
          expect(
            (yield* api.request(actors.member, "GET", `${prefix}/apps/${app.id}/source`)).status,
          ).toBe(403);
          expect(
            (yield* api.request(actors.member, "DELETE", `${prefix}/apps/${app.id}`)).status,
          ).toBe(403);
          // Enabled manager controls still navigate and preserve their existing interactions.
          yield* browser.login(actors.owner);
          yield* browser.use("Owner opens the same app", (page) =>
            page.goto(`${url}?view=overview`),
          );
          yield* browser.use("Owner source tab is enabled", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Source", exact: true })
              .click(),
          );
          yield* browser.use("Owner reads source", (page) =>
            page.getByRole("region", { name: "Source browser", exact: true }).waitFor(),
          );
        }),
      ),
    );
});
