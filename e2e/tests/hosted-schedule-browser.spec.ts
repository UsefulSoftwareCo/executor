/** The same dashboard controls and browser approval, driven through the hosted product. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";

class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}
const source = `import { defineApp, mutation, object, interval } from "apps";
import { always } from "apps/operations/approval";
const send = mutation({ input: object({}), approval: always() }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({  mutations: { send }, schedules: { digest: interval({ hours: 1 }, send, {}) } }));`;
layer(HostedLive, { excludeTestServices: true })("Hosted schedule dashboard", (it) => {
  it.effect(scenarios.scheduleLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Schedule layout ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const paths = [actors.organization.id, actors.organization.slug].map(
          (organization) => `/api/organizations/${organization}/apps/${app.id}`,
        );
        const frame = (title: string) =>
          browser.use(`Measure ${title} tab navigation`, (page) =>
            page
              .getByRole("navigation", { name: "App navigation", includeHidden: true })
              .evaluate((element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
              }),
          );
        yield* browser.login(actors.owner);
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* browser.use("Set the viewport", (page) => page.setViewportSize(viewport));
              yield* browser.use("Open the reference tab", (page) =>
                page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=overview`),
              );
              yield* browser.use("The reference content is visible", (page) =>
                page.getByRole("region", { name: "App tools preview", exact: true }).waitFor(),
              );
              const reference = yield* frame("Overview");
              // Inventory can supply the same metadata before the app read completes.
              const metadata = yield* holdQuery(
                [
                  ...paths,
                  ...[actors.organization.id, actors.organization.slug].map(
                    (organization) => `/api/organizations/${organization}/inventory`,
                  ),
                ],
                "continue",
                { allRequests: true },
              );
              const settings = yield* holdQuery(
                paths.map((path) => `${path}/schedules`),
                "continue",
                { allRequests: true },
              );
              const definitions = yield* holdQuery(
                paths.map((path) => `${path}/schedules/definitions`),
                "continue",
                { allRequests: true },
              );
              yield* browser.use("Open Schedules with its reads held", (page) =>
                page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=schedules`),
              );
              yield* metadata.requested;
              expect(
                yield* browser.use(
                  "Schedules has no duplicate subhead while metadata loads",
                  (page) =>
                    page
                      .getByRole("navigation", { name: "App navigation" })
                      .getByRole("link", { name: "Schedules", exact: true })
                      .count(),
                ),
              ).toBe(0);
              expect(yield* frame("Schedules")).toEqual(reference);
              expect(
                yield* browser.use("Schedules has row-shaped skeletons", (page) =>
                  page
                    .getByRole("status", { name: "Loading schedules", exact: true })
                    .locator("[data-slot=skeleton]")
                    .count(),
                ),
              ).toBeGreaterThan(4);
              yield* browser.checkpoint(`${viewport.width} schedules metadata pending`);
              yield* metadata.release;
              yield* settings.requested;
              // Discovery must start while settings is still held, rather than forming a waterfall.
              yield* definitions.requested;
              expect(yield* frame("Schedules")).toEqual(reference);
              expect(
                yield* browser.use("Schedules never shows the inventory skeleton", (page) =>
                  page.locator(".loading-rows").count(),
                ),
              ).toBe(0);
              const introduction = yield* browser.use("Measure the schedule introduction", (page) =>
                page
                  .getByText(
                    "Schedules run with this app’s selected accounts. New schedules start paused.",
                    { exact: true },
                  )
                  .boundingBox(),
              );
              yield* browser.checkpoint(`${viewport.width} schedules settings pending`);
              yield* settings.release;
              yield* browser.use("Discovery keeps the same neutral loading state", (page) =>
                page.getByRole("status", { name: "Loading schedules", exact: true }).waitFor(),
              );
              expect(yield* frame("Schedules")).toEqual(reference);
              yield* browser.checkpoint(`${viewport.width} schedules discovery pending`);
              yield* definitions.release;
              yield* browser.use("Declared schedules arrive", (page) =>
                page.getByRole("heading", { name: "digest", exact: true }).waitFor(),
              );
              expect(yield* frame("Schedules")).toEqual(reference);
              expect(
                yield* browser.use("The introduction stays in place", (page) =>
                  page
                    .getByText(
                      "Schedules run with this app’s selected accounts. New schedules start paused.",
                      { exact: true },
                    )
                    .boundingBox(),
                ),
              ).toEqual(introduction);
              yield* browser.use("Schedule controls fit the viewport", (page) =>
                page.getByRole("button", { name: "Enable", exact: true }).waitFor(),
              );
              expect(
                yield* browser.use("The schedule tab does not overflow horizontally", (page) =>
                  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                ),
              ).toBe(true);
              yield* browser.checkpoint(`${viewport.width} schedules loaded`);
              yield* browser.use("Open schedule approvals before a refresh", (page) =>
                page.getByRole("combobox", { name: "Approvals for digest", exact: true }).click(),
              );
              const refresh = yield* holdQuery(
                paths.map((path) => `${path}/schedules`),
                "fail",
              );
              yield* refreshVisiblePage;
              yield* refresh.requested;
              yield* refresh.release;
              yield* browser.use("A settings refresh failure is visible", (page) =>
                page.getByText("Unable to complete this request", { exact: true }).waitFor(),
              );
              expect(yield* frame("Schedules")).toEqual(reference);
              expect(
                yield* browser.use("The open approvals menu survives a refresh failure", (page) =>
                  page.getByRole("option", { name: "Browser approvals", exact: true }).isVisible(),
                ),
              ).toBe(true);
              yield* browser.checkpoint(`${viewport.width} schedules refresh failure`);
              yield* browser.use("Close the approvals menu", (page) =>
                page.keyboard.press("Escape"),
              );
              yield* browser.use("Retry saved schedule settings", (page) =>
                page.getByRole("button", { name: "Retry", exact: true }).click(),
              );
              yield* browser.use("Settings recover without replacing the tab", (page) =>
                page
                  .getByText("Unable to complete this request", { exact: true })
                  .waitFor({ state: "hidden" }),
              );
              expect(yield* frame("Schedules")).toEqual(reference);
            }),
          );
        }
      }),
    ),
  );

  it.effect(scenarios.scheduleDiscoveryStates.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Schedule states ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [{ path: "index.ts", content: source }],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const paths = [actors.organization.id, actors.organization.slug].map(
          (organization) =>
            `/api/organizations/${organization}/apps/${app.id}/schedules/definitions`,
        );
        const noFalseEmpty = (phase: string) =>
          Effect.gen(function* () {
            expect(
              yield* browser.use(
                `${phase}: failed discovery is not an empty schedule list`,
                (page) =>
                  page.getByRole("heading", { name: "No schedules yet", exact: true }).count(),
              ),
            ).toBe(0);
          });
        yield* browser.login(actors.owner);
        const failed = yield* holdQuery(paths, "fail");
        yield* browser.use("Open schedules with definition discovery held", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=schedules`),
        );
        yield* failed.requested;
        yield* browser.use("Definition discovery is loading", (page) =>
          page.getByRole("status", { name: "Loading schedules", exact: true }).waitFor(),
        );
        yield* noFalseEmpty("Initial loading");
        yield* failed.release;
        yield* browser.use("The discovery failure is visible", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).waitFor(),
        );
        yield* noFalseEmpty("Initial failure");
        yield* browser.checkpoint("Failed discovery without a false empty state");
        yield* browser.use("Retry schedule discovery", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).click(),
        );
        yield* browser.use("The declared schedule appears", (page) =>
          page.getByRole("heading", { name: "digest", exact: true }).waitFor(),
        );
        const refreshFailure = yield* holdQuery(paths, "fail");
        yield* refreshVisiblePage;
        yield* refreshFailure.requested;
        yield* refreshFailure.release;
        yield* browser.use("The refresh failure is visible", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Refresh failure keeps the known schedule", (page) =>
            page.getByRole("heading", { name: "digest", exact: true }).isVisible(),
          ),
        ).toBe(true);
        yield* noFalseEmpty("Refresh failure");
        const empty = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `${name} empty`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";
export default defineApp({ accounts: {} }, async () => ({  }));`,
            },
          ],
        });
        expect(empty.status).toBe(200);
        const emptyApp = yield* body(Schema.Struct({ id: Schema.String }), empty);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${emptyApp.id}`).pipe(Effect.orDie),
        );
        yield* browser.use("Open the app without schedules", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${emptyApp.id}?view=schedules`),
        );
        yield* browser.use("Successful discovery can report an empty list", (page) =>
          page.getByRole("heading", { name: "No schedules yet", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("An empty schedule list retains the subhead", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Schedules", exact: true })
              .count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Confirmed empty schedule list");
      }),
    ),
  );

  it.effect(scenarios.scheduleAccountSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Schedule account ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Schedule fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async () => ({  }));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/schedules/definitions`,
          )).status,
        ).toBe(409);
        yield* browser.login(actors.owner);
        yield* browser.use("Open schedules without a selected account", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("Account setup explains the blocked discovery", (page) =>
          page
            .getByText("Choose accounts in Accounts to start using this app.", { exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Missing accounts do not imply no schedules", (page) =>
            page.getByRole("heading", { name: "No schedules yet", exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Account setup replaces ineffective retry", (page) =>
            page.getByRole("button", { name: "Retry", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Schedules need account setup");
        yield* browser.use("Open account recovery", (page) =>
          page.getByRole("button", { name: "Go to Accounts", exact: true }).click(),
        );
        yield* browser.use("The account selection action is available", (page) =>
          page.getByRole("button", { name: "Add Schedule fixture account", exact: true }).waitFor(),
        );
      }),
    ),
  );

  it.effect(scenarios.hostedScheduleBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Browser schedules ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const view = `/org/${actors.organization.slug}/apps/${app.id}?view=schedules`;
        yield* browser.login(actors.owner);
        yield* browser.use("Open schedule controls", (page) => page.goto(view));
        yield* browser.use("Choose approval mode", (page) =>
          page.getByRole("combobox", { name: "Approvals for digest" }).click(),
        );
        yield* browser.use("Use browser approvals", (page) =>
          page.getByRole("option", { name: "Browser approvals" }).click(),
        );
        yield* browser.use("Enable the schedule", (page) =>
          page.getByRole("button", { name: "Enable", exact: true }).click(),
        );
        yield* browser.use("Wait for enabled controls", (page) =>
          page.getByRole("button", { name: "Pause", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("01 Hosted schedule controls");
        expect(
          yield* browser.use("Request a run and wait for acceptance", (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "POST" &&
                  new URL(response.url()).pathname.endsWith("/schedules/digest/run"),
              ),
              page.getByRole("button", { name: "Run now", exact: true }).click(),
            ]).then(([response]) => response.status()),
          ),
        ).toBe(200);
        yield* browser.use("Open approvals", (page) =>
          page.getByRole("link", { name: "Approvals", exact: true }).click(),
        );
        yield* browser.use("Reload the approval queue", (page) => page.reload());
        yield* browser.use("Wait for pending approval", (page) =>
          page.getByRole("link", { name: "Review", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("02 Hosted approvals list");
        yield* browser.use("Review the pending run", (page) =>
          page.getByRole("link", { name: "Review", exact: true }).click(),
        );
        yield* browser.use("Reload the bookmarked approval", (page) => page.reload());
        yield* browser.use("Wait for approval form", (page) =>
          page.getByRole("button", { name: "Approve", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("03 Review scheduled run");
        yield* browser.use("Approve the mutation", (page) =>
          page.getByRole("button", { name: "Approve", exact: true }).click(),
        );
        yield* browser.use("Observe acknowledgement", (page) =>
          page
            .getByText("Your response was saved. Approved runs continue in the background.", {
              exact: true,
            })
            .waitFor(),
        );
        yield* browser.checkpoint("04 Approval saved");
        const evidence = yield* Evidence;
        yield* api.request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`).pipe(
          Effect.flatMap((response) =>
            body(
              Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  status: Schema.String,
                  failure: Schema.NullOr(Schema.String),
                }),
              ),
              response,
            ),
          ),
          Effect.flatMap((runs) =>
            Effect.gen(function* () {
              yield* evidence.json("approved-schedule-runs.json", runs);
              const completed = runs.find(
                (run) => !["ready", "running", "awaiting-approval"].includes(run.status),
              );
              if (completed === undefined) return yield* new Pending();
              expect(
                completed,
                "The approved run must complete; terminal failures are not slow runs",
              ).toMatchObject({ status: "succeeded", failure: null });
            }),
          ),
          Effect.retry({
            while: (error) => error instanceof Pending,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeout("30 seconds"),
        );
        yield* browser.use("Reopen schedule controls", (page) => page.goto(view));
        yield* browser.use("Pause the schedule", (page) =>
          page.getByRole("button", { name: "Pause", exact: true }).click(),
        );
        yield* browser.use("Observe paused state", (page) =>
          page.getByRole("button", { name: "Enable", exact: true }).waitFor(),
        );
        expect(
          yield* body(
            Schema.Array(Schema.Struct({ enabled: Schema.Boolean })),
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/schedules`),
          ),
        ).toEqual([{ enabled: false }]);
      }),
    ),
  );
});
