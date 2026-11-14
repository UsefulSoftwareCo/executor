/**
 * When a self-host instance cannot read its app feed, or its operator turned the catalog off,
 * onboarding, Add app and the agent's catalog tool say why Executor's official apps are missing,
 * and the built-in Executor app stays listed.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { createServer } from "node:http";
import type { Page } from "playwright";
import { Browser } from "../support/browser.ts";
import { holdQuery } from "../support/query-transition.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target, driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Listing = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ package: Schema.String })),
  feed: Schema.Union([
    Schema.Struct({ status: Schema.Literal("listed") }),
    Schema.Struct({ status: Schema.Literal("off"), message: Schema.String }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      error: Schema.Struct({
        _tag: Schema.Literal("CatalogFeedUnavailable"),
        message: Schema.String,
        recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      }),
    }),
  ]),
});
/** The array `organization.catalog` has always returned. */
const Entries = Schema.Array(Schema.Struct({ package: Schema.String }));
const Inventory = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      activeDeployment: Schema.NullOr(Schema.String),
    }),
  ),
});

const unavailableTitle = "App catalog unavailable";
const unavailableDescription =
  "This Executor server could not read its app catalog feed just now, so this request to list or add Executor’s official apps did not complete.";
/** Who can repair it, on any host. */
const unavailableRepair =
  "If it keeps failing on Executor Cloud, contact Executor support; on a self-hosted or local server, whoever runs it should check its EXECUTOR_CATALOG_URL setting, its outbound internet access, and that the feed returns valid catalog data.";
/**
 * What `organization.catalog` fails with when the feed cannot be read: the description, then the
 * next step, because an agent may read nothing but this message.
 */
const unavailableMessage = `${unavailableDescription} Nothing was added, and the apps still exist. Try again shortly; if it still fails, add the app from its MCP server URL or build it. ${unavailableRepair}`;
const unavailableAction = `Try again. ${unavailableRepair}`;
const offTitle = "App catalog turned off";
const offText =
  "Executor’s official apps are not listed because this instance’s app catalog is turned off. Whoever runs it can list them by removing EXECUTOR_CATALOG_URL=off.";

/** A notice's text explains the unread feed and the next step, whichever layout shows it. */
const expectUnavailable = (text: string) => {
  expect(text).toContain(unavailableDescription);
  expect(text).toContain(unavailableAction);
};

/**
 * Try again while the listing's read is held: the notice says it is checking and cannot be pressed
 * again, then offers Try again once the read answers.
 */
const heldRetry = (where: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Browser;
      const catalog = yield* holdQuery(/\/api\/catalog$/u, "continue");
      yield* browser.use(`Try the catalog again on ${where}`, (page) =>
        page.getByRole("button", { name: "Try again", exact: true }).click(),
      );
      yield* catalog.requested;
      expect(
        yield* browser.use(`${where} shows the retry checking`, (page) =>
          Promise.all([
            page.getByRole("button", { name: "Checking…", exact: true }).isDisabled(),
            page.getByRole("status", { name: "Checking the app catalog", exact: true }).count(),
          ]),
        ),
      ).toEqual([true, 1]);
      yield* browser.checkpoint(`${where} while Try again reads the catalog`);
      yield* catalog.release;
      yield* browser.use(`${where} offers Try again once the read answers`, (page) =>
        page.getByRole("button", { name: "Try again", exact: true }).waitFor(),
      );
    }),
  );

/** Run first-run setup in the browser and wait for onboarding's account step to settle. */
const setUp = (origin: string, email: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Open first-run setup", (page) => page.goto(`${origin}/login`));
    yield* browser.use("Name the organization", (page) =>
      page.getByLabel("Organization name", { exact: true }).fill("Example Studio"),
    );
    yield* browser.use("Name the administrator", (page) =>
      page.getByLabel("Your name", { exact: true }).fill("Alex Example"),
    );
    yield* browser.use("Enter administrator email", (page) =>
      page.getByLabel("Email", { exact: true }).fill(email),
    );
    yield* browser.use("Enter administrator password", (page) =>
      page.getByLabel("Password", { exact: true }).fill("password"),
    );
    yield* browser.use("Create the administrator", (page) =>
      page.getByRole("button", { name: "Create administrator account", exact: true }).click(),
    );
    yield* browser.use("Setup opens the account step", (page) =>
      page.waitForURL(new RegExp(`^${origin}/org/[^/]+/setup/accounts$`, "u")),
    );
    yield* browser.use("The account step settles", (page) =>
      page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
    );
    return yield* browser.use("Read the organization's address", (page) =>
      Promise.resolve(new URL(page.url()).pathname.split("/")[2]!),
    );
  });

/** A notice's heading and text, as a person reads it. */
const notice = (page: Page, title: string) =>
  page
    .getByRole("heading", { name: title, exact: true })
    .locator("xpath=..")
    .evaluate((element) => (element instanceof HTMLElement ? element.innerText : ""));

/** Send a request as the signed-in browser does, and keep its status and body. */
const request = (route: string, body?: unknown) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser.use(`Request ${route}`, (page) =>
      page.evaluate(
        ({ route, body }) =>
          fetch(route, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }).then((response) =>
            response.text().then((text) => ({ status: response.status, text })),
          ),
        { route, body },
      ),
    );
  });

/** A response's body, decoded, after checking its status. */
const answered = <S extends Schema.Top>(
  schema: S,
  status: number,
  response: { readonly status: number; readonly text: string },
) =>
  Effect.gen(function* () {
    expect(response.status, response.text).toBe(status);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.text);
  });

/** Read a route that answers 200 as the signed-in browser does. */
const read = <S extends Schema.Top>(schema: S, route: string, body?: unknown) =>
  request(route, body).pipe(Effect.flatMap((response) => answered(schema, 200, response)));

layer(TestLive, { excludeTestServices: true })("Self-host catalog feed", (it) => {
  it.effect(scenarios.selfHostCatalogFeed.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;

        // A feed address that answers with a sign-in page instead of a feed, as a captive portal
        // or a misconfigured proxy would.
        let feedRequests = 0;
        const feed = yield* Effect.acquireRelease(
          driver(
            "start the unusable feed",
            () =>
              new Promise<{ server: ReturnType<typeof createServer>; port: number }>(
                (resolve, reject) => {
                  const server = createServer((_request, response) => {
                    feedRequests += 1;
                    response.writeHead(200, { "content-type": "text/html" });
                    response.end("<html><body>Sign in to this network</body></html>");
                  });
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    const address = server.address();
                    if (address === null || typeof address === "string")
                      return reject(new Error("No feed port"));
                    resolve({ server, port: address.port });
                  });
                },
              ),
          ),
          ({ server }) => Effect.sync(() => server.close()),
        );

        // Each instance stops before the next starts, so the scenario never runs two at once.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const unreadable = yield* startFreshSelfHost(target, {
              EXECUTOR_CATALOG_URL: `http://127.0.0.1:${feed.port}/index.json`,
            });
            const slug = yield* setUp(unreadable, "alex@example.test");
            expect(feedRequests).toBeGreaterThan(0);
            expectUnavailable(
              yield* browser.use("Onboarding says the feed could not be read", (page) =>
                notice(page, unavailableTitle),
              ),
            );
            expect(
              yield* browser.use("Onboarding still offers to skip", (page) =>
                page.getByRole("link", { name: "Skip for now", exact: true }).isVisible(),
              ),
            ).toBe(true);
            yield* browser.checkpoint("Onboarding when the app feed cannot be read");
            yield* heldRetry("Onboarding");

            yield* browser.use("Open Add app", (page) =>
              page.goto(`${unreadable}/org/${slug}/apps/add`),
            );
            expectUnavailable(
              yield* browser.use("Add app says the feed could not be read", (page) =>
                notice(page, unavailableTitle),
              ),
            );
            expect(
              yield* browser.use("The built-in Executor app is still listed", (page) =>
                page
                  .locator(".catalog-row", { hasText: "Manage apps and connected accounts" })
                  .count(),
              ),
            ).toBe(1);
            yield* browser.checkpoint("Add app when the app feed cannot be read");
            yield* heldRetry("Add app");

            // The dashboards' session listing keeps the Executor app and says why, and what to do.
            const [organization] = yield* read(
              Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
              "/api/auth/organization/list",
            );
            const listing = yield* read(Listing, "/api/catalog");
            expect(listing.apps.map((entry) => entry.package)).toEqual(["executor"]);
            if (listing.feed.status !== "unavailable")
              return yield* Effect.die(`The feed reads as ${listing.feed.status}`);
            expect(listing.feed.error.message).toBe(unavailableDescription);
            expect(listing.feed.error.recovery.action).toBe(unavailableAction);
            expect(listing.feed.error.recovery.instructions).toContain("EXECUTOR_CATALOG_URL=off");
            expect(listing.feed.error.recovery.instructions).toContain("apps.importCustom");

            // API keys and agents keep organization.catalog's response: an unread feed fails it with
            // exactly the `_tag` and `message` it always has, the message now saying what to do.
            const failed = yield* request(`/api/organizations/${organization.id}/catalog`);
            expect(failed.status, failed.text).toBe(502);
            expect(JSON.parse(failed.text)).toEqual({
              _tag: "CatalogUnavailable",
              message: unavailableMessage,
            });

            // The agent's catalog tool, the Executor app's organization.catalog, returns the same.
            const executor = yield* read(
              Inventory,
              `/api/organizations/${organization.id}/inventory`,
            ).pipe(
              Effect.map((inventory) =>
                inventory.apps.find(
                  (app) => app.slug === "executor" && app.activeDeployment !== null,
                ),
              ),
              Effect.flatMap((app) =>
                app === undefined ? Effect.fail("not deployed") : Effect.succeed(app),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
            );
            // An agent calling it through the Executor app gets the failure with the service's own
            // words quoted, the next step included. The app adds its own retry advice for any 5xx.
            const agent = yield* answered(
              Schema.Struct({ _tag: Schema.Literal("AppProviderFailed"), message: Schema.String }),
              502,
              yield* request(
                `/api/organizations/${organization.id}/apps/${executor.id}/tools/call`,
                {
                  tool: "organization.catalog",
                  input: { path: { organization: organization.id }, query: { search: "mail" } },
                },
              ),
            );
            expect(agent.message).toContain(`CatalogUnavailable: "${unavailableMessage}"`);
          }),
        );

        // Turned off: only built-in apps, a note that says so, and no feed request.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const before = feedRequests;
            const off = yield* startFreshSelfHost(target, { EXECUTOR_CATALOG_URL: "off" });
            const offSlug = yield* setUp(off, "sam@example.test");
            expect(
              yield* browser.use("Onboarding says the catalog is off", (page) =>
                notice(page, offTitle),
              ),
            ).toContain(offText);
            yield* browser.checkpoint("Onboarding when the app catalog is turned off");
            yield* browser.use("Open Add app on the instance with the catalog off", (page) =>
              page.goto(`${off}/org/${offSlug}/apps/add`),
            );
            expect(
              yield* browser.use("Add app says the catalog is off", (page) =>
                notice(page, offTitle),
              ),
            ).toContain(offText);
            yield* browser.checkpoint("Add app when the app catalog is turned off");
            const [offOrganization] = yield* read(
              Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
              "/api/auth/organization/list",
            );
            const offListing = yield* read(Listing, "/api/catalog");
            expect(offListing.apps.map((entry) => entry.package)).toEqual(["executor"]);
            expect(offListing.feed.status).toBe("off");
            // organization.catalog lists the built-in apps, as it always has.
            expect(
              (yield* read(Entries, `/api/organizations/${offOrganization.id}/catalog`)).map(
                (entry) => entry.package,
              ),
            ).toEqual(["executor"]);
            expect(feedRequests).toBe(before);
          }),
        );
      }),
    ),
  );
});
