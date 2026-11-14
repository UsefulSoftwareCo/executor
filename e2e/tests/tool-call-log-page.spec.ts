/**
 * The Activity page lists the organization's tool call log. Its search and filters live in the
 * address, a pasted reference opens that one call, and a call's details narrow the list to its run.
 * A member sees only their own calls. The tool runner shows a failed run's reference, which opens the
 * same call there.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import type { Locator, Page } from "playwright";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";
import { holdQuery } from "../support/query-transition.ts";

const reference = /^call_[0-9a-hjkmnp-tv-z]{14}$/u;
const source = `
import { defineApp, mutation, query, object, string, router, ProviderError } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ description: "Echo text", input: object({ text: string() }) },
    async (_, input) => ({ echoed: input.text })),
  explode: query({ description: "Fail with the text", input: object({ text: string() }) },
    async (_, input) => { throw new Error("The service refused " + input.text); }),
  forbidden: mutation({ description: "Fail with a 403", input: object({ text: string() }) },
    async () => { throw new ProviderError({ reason: "forbidden", status: 403 }); }),
}) }));`;
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Viewer = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    image: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
/** A one-pixel picture the browser loads without a network request. */
const picture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const Failure = Schema.Struct({ reference: Schema.String });
const Caught = Schema.Struct({
  execution: Schema.Struct({
    value: Schema.Struct({ reference: Schema.String }),
  }),
});

/** The fixture app, shared with everyone so the member may call it. */
const deployApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Release desk ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  const path = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  const access = yield* body(
    Schema.Struct({ revision: Schema.String }),
    yield* api.request(actors.owner, "GET", `${path}/access`),
  );
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  return { app, path };
});

const apiKey = (actor: Session, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const key = yield* body(
      Key,
      yield* api.request(actor, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
    );
    return key;
  });

/**
 * Eight calls: the owner's key makes two, the member's key three, and the owner's MCP program three
 * in one run, one of them a caught failure.
 */
const seedCalls = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    mcp = yield* McpClient;
  const { app, path } = yield* deployApp;
  const [ownerKey, memberKey] = yield* Effect.all([
    apiKey(actors.owner, "Owner key"),
    apiKey(actors.member, "Member key"),
  ]);
  const agent = yield* api.session();
  const call = (key: typeof ownerKey, tool: string) =>
    api.request(
      agent,
      "POST",
      `${path}/tools/call`,
      { tool, input: { text: "page" } },
      { authorization: `Bearer ${Redacted.value(key.key)}` },
    );
  yield* call(ownerKey, "echo");
  const ownerFailure = (yield* body(Failure, yield* call(ownerKey, "explode"))).reference;
  yield* call(memberKey, "echo");
  yield* call(memberKey, "explode");
  const memberForbidden = (yield* body(Failure, yield* call(memberKey, "forbidden"))).reference;
  const client = yield* mcp.connect(ownerKey.key, "page-program", {
    organization: actors.organization.id,
  });
  const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
  const program = yield* client.use("The owner runs a program", (client, signal) =>
    client.callTool(
      {
        name: "execute",
        arguments: {
          code: `await ${tool("echo")}({ text: "one" });
await ${tool("echo")}({ text: "two" });
try { await ${tool("explode")}({ text: "three" }); return { reference: "none" }; }
catch (error) { return { reference: error.reference }; }`,
        },
      },
      undefined,
      { signal },
    ),
  );
  const runFailure = (yield* Schema.decodeUnknownEffect(Caught)(program.structuredContent))
    .execution.value.reference;
  for (const id of [ownerFailure, memberForbidden, runFailure]) expect(id).toMatch(reference);
  const member = (yield* body(
    Viewer,
    yield* api.request(actors.member, "GET", "/api/auth/get-session"),
  )).user;
  // The calls that succeeded are written after their responses; the page reads all eight.
  yield* api
    .request(
      actors.owner,
      "GET",
      `/api/organizations/${actors.organization.id}/tool-calls?app=${app.id}&range=24h`,
    )
    .pipe(
      Effect.flatMap((response) => body(Schema.Struct({ total: Schema.Number }), response)),
      Effect.repeat({ until: ({ total }) => total >= 8, schedule: Schedule.spaced("100 millis") }),
      Effect.timeout("10 seconds"),
    );
  return { app, path, ownerFailure, memberForbidden, runFailure, member };
});

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const summary = (page: Page) => page.getByRole("status").first();
const calls = (page: Page) => page.getByRole("list", { name: "Tool calls", exact: true });
/** The summary once it reads `text`, after the list it counts has loaded. */
const summaryReads = (page: Page, text: string) =>
  page
    .getByRole("status")
    .filter({ hasText: new RegExp(`^${escaped(text)}$`, "u") })
    .first()
    .waitFor()
    .then(() => summary(page).textContent());
/** A row is a button that opens its call, named by the row's own text. */
const rows = (page: Page) => calls(page).locator("button[aria-expanded]");
const rowCount = (page: Page) => rows(page).count();
const openFilter = (page: Page, filter: string) =>
  page
    .getByRole("button", { name: /^Filter/u })
    .click()
    .then(() =>
      page
        .getByRole("group", { name: "Filters" })
        .getByRole("menuitem", { name: new RegExp(`^${filter}`, "u") })
        .click(),
    );
/** The open Filter menu's rows, once it has finished opening: each row's text and where it is. */
const filterRows = (page: Page) => {
  const filters = page.getByRole("group", { name: "Filters" });
  return filters
    .evaluate((group) =>
      Promise.all(
        (group.closest("[role=menu]") ?? group)
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    )
    .then(() =>
      filters.getByRole("menuitem").evaluateAll((rows) =>
        rows.map((row) => ({
          text: row.textContent,
          top: Math.round(row.getBoundingClientRect().top),
        })),
      ),
    );
};
/** Where an element's text starts on screen, whatever box or touch target surrounds it. */
const textTop = (element: Locator) =>
  element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().top;
  });
/** Vertical distance between the text of a detail field's label and of its first value line. */
const misalignment = (detail: Locator, label: string, value: Locator) =>
  Promise.all([textTop(detail.locator("dt", { hasText: label })), textTop(value)]).then(
    ([dt, dd]) => Math.abs(dt - dd),
  );

layer(HostedLive, { excludeTestServices: true })("Tool call log page", (it) => {
  it.effect(scenarios.toolCallLogPage.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser;
        const seeded = yield* seedCalls;
        const slug = actors.organization.slug;
        yield* Effect.acquireRelease(
          api.request(actors.member, "POST", "/api/auth/update-user", { image: picture }),
          () =>
            api
              .request(actors.member, "POST", "/api/auth/update-user", {
                image: seeded.member.image ?? null,
              })
              .pipe(Effect.orDie),
        );
        yield* browser.login(actors.admin);
        yield* browser.use("Allow the page to copy", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );

        yield* browser.use("Open the dashboard", (page) => page.goto(`/org/${slug}`));
        // The Filter menu's choices are read after the list; this holds that read.
        const choices = yield* holdQuery(/\/tool-calls\/filters$/u, "continue");
        yield* browser.use("Open Activity from the sidebar", (page) =>
          page.getByRole("link", { name: "Activity", exact: true }).first().click(),
        );
        expect(
          yield* browser.use("The list shows every call", (page) =>
            summaryReads(page, "8 tool calls in the last 7 days"),
          ),
        ).toBe("8 tool calls in the last 7 days");
        expect(yield* browser.use("Count the rows", rowCount)).toBe(8);
        // A row's name is its own text, so a screen reader hears who made the call and when.
        expect(
          yield* browser.use("Read a row's accessible name", (page) =>
            calls(page)
              .getByRole("button", { name: new RegExp(escaped(seeded.member.name), "u") })
              .count(),
          ),
        ).toBe(3);
        // A member's calls show their own picture, as the members list does.
        expect(
          yield* browser.use("Read the picture beside a member's call", (page) => {
            const image = calls(page)
              .getByRole("button", { name: new RegExp(escaped(seeded.member.name), "u") })
              .first()
              .locator("img");
            return image.waitFor().then(() => image.getAttribute("src"));
          }),
        ).toBe(picture);
        expect(
          yield* browser.use("Read the address", (page) =>
            Promise.resolve(new URL(page.url()).pathname),
          ),
        ).toBe(`/org/${slug}/activity`);
        yield* browser.checkpoint("Every call in the organization");

        // Opened before its choices arrive, the menu lists every filter that may have some, and
        // no row moves when they arrive: a row added above would take the pointer's place.
        yield* choices.requested;
        yield* browser.use("Open the filters while their choices load", (page) =>
          page.getByRole("button", { name: "Filter", exact: true }).click(),
        );
        const loading = yield* browser.use("Read the filters while their choices load", filterRows);
        expect(loading.map((row) => row.text?.split(/All |Last /u)[0])).toEqual([
          "Member",
          "App",
          "Status",
          "Agent",
          "Connection",
          "Time range",
        ]);
        yield* browser.use("A filter's choices say they are loading", (page) =>
          page
            .getByRole("group", { name: "Filters" })
            .getByRole("menuitem", { name: /^App/u })
            .hover()
            .then(() =>
              page
                .getByRole("group", { name: "App", exact: true })
                .getByRole("status")
                .filter({ hasText: "Loading choices…" })
                .waitFor(),
            ),
        );
        const arrival = yield* browser.use("Watch for the filters' choices", (page) =>
          Promise.resolve({
            response: page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith("/tool-calls/filters"),
            ),
          }),
        );
        yield* choices.release;
        yield* browser.use("The filters' choices arrive", (page) =>
          arrival.response.then(() =>
            page
              .getByRole("group", { name: "App", exact: true })
              .getByRole("status")
              .waitFor({ state: "detached" }),
          ),
        );
        expect(
          yield* browser.use("Read the filters once their choices arrived", filterRows),
        ).toEqual(loading);
        yield* browser.use("Close the menu that opened while loading", (page) =>
          page.keyboard
            .press("Escape")
            .then(() =>
              page.getByRole("group", { name: "Filters" }).waitFor({ state: "detached" }),
            ),
        );

        // The Filter menu narrows by status, then by member; chips and the count follow. Resting
        // the pointer on a filter opens its choices beside the filters, which stay; resting it on
        // another filter replaces them with that filter's.
        const beside = yield* browser.use("Rest the pointer on a filter, then another", (page) => {
          const filters = page.getByRole("group", { name: "Filters" });
          const failed = page.getByRole("menuitemradio", { name: "Failed", exact: true });
          return page
            .getByRole("button", { name: "Filter", exact: true })
            .click()
            .then(() => filters.getByRole("menuitem", { name: /^Status/u }).hover())
            .then(() => failed.waitFor())
            .then(() => filters.isVisible())
            .then((stayed) =>
              // App is above Status, so the pointer does not cross the way to Status's choices.
              filters
                .getByRole("menuitem", { name: /^App/u })
                .hover()
                .then(() => page.getByRole("group", { name: "App", exact: true }).waitFor())
                .then(() => failed.waitFor({ state: "detached" }))
                .then(() => stayed),
            );
        });
        expect(beside).toBe(true);
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));
        // While the failed calls load, the previous list stays, but not its count.
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const failedList = /\/tool-calls\?(?:.*&)?status=failed/u;
        yield* browser.use("Hold the failed calls", (page) =>
          page.route(failedList, (route) => held.then(() => route.continue())),
        );
        yield* browser.use("Filter by status", (page) =>
          openFilter(page, "Status").then(() =>
            page.getByRole("menuitemradio", { name: "Failed", exact: true }).click(),
          ),
        );
        expect(
          yield* browser.use("The count waits for the failed calls", (page) =>
            summaryReads(page, "Loading tool calls…").then((text) =>
              Promise.all([
                Promise.resolve(text),
                page
                  .getByRole("button", { name: "Remove filter Status: Failed", exact: true })
                  .count(),
                rowCount(page),
              ]),
            ),
          ),
        ).toEqual(["Loading tool calls…", 1, 8]);
        yield* browser.checkpoint("A new filter's calls loading");
        // Released, the route passes every later read straight through.
        yield* browser.use("Release the failed calls", () => Promise.resolve(release()));
        expect(
          yield* browser.use("Only failed calls are counted", (page) =>
            summaryReads(page, "4 tool calls in the last 7 days"),
          ),
        ).toBe("4 tool calls in the last 7 days");
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Filter by member", (page) =>
          openFilter(page, "Member").then(() =>
            // The choice's name starts with the member's initials, which its avatar shows.
            page
              .getByRole("menuitemradio", {
                name: new RegExp(`${escaped(seeded.member.name)}$`, "u"),
              })
              .click(),
          ),
        );
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));
        const filtered = yield* browser.use("Read the filtered list", (page) =>
          summaryReads(page, "2 tool calls in the last 7 days").then((text) =>
            Promise.all([
              Promise.resolve(text),
              rowCount(page),
              page
                .getByRole("button", { name: "Remove filter Status: Failed", exact: true })
                .count(),
              page
                .getByRole("button", {
                  name: `Remove filter Member: ${seeded.member.name}`,
                  exact: true,
                })
                .count(),
              page.getByRole("button", { name: "Filter, 2 applied", exact: true }).count(),
              Promise.resolve(Object.fromEntries(new URL(page.url()).searchParams)),
            ]),
          ),
        );
        expect(filtered).toEqual([
          "2 tool calls in the last 7 days",
          2,
          1,
          1,
          1,
          { status: "failed", member: seeded.member.id },
        ]);
        yield* browser.checkpoint("Failed calls by one member");
        // The address carries the filters, so a reload shows the same list.
        const reloaded = yield* browser.use("Reload the filtered list", (page) =>
          page
            .reload()
            .then(() => summaryReads(page, "2 tool calls in the last 7 days"))
            .then((text) =>
              Promise.all([
                Promise.resolve(text),
                rowCount(page),
                page.getByRole("button", { name: /^Remove filter /u }).count(),
              ]),
            ),
        );
        expect(reloaded).toEqual(["2 tool calls in the last 7 days", 2, 2]);
        yield* browser.use("Remove the status chip", (page) =>
          page.getByRole("button", { name: "Remove filter Status: Failed", exact: true }).click(),
        );
        expect(
          yield* browser.use("The member's calls are counted", (page) =>
            summaryReads(page, "3 tool calls in the last 7 days"),
          ),
        ).toBe("3 tool calls in the last 7 days");

        // A pasted reference shows that one call, open, whatever the address filters by.
        yield* browser.use("Paste a reference", (page) =>
          page
            .getByRole("textbox", { name: "Search or paste a reference", exact: true })
            .fill(seeded.ownerFailure),
        );
        const detail = (page: Page, id: string) =>
          page.getByRole("region", { name: `Details of ${id}`, exact: true });
        const shown = yield* browser.use("The referenced call opens", (page) =>
          detail(page, seeded.ownerFailure)
            .waitFor()
            .then(() =>
              Promise.all([
                summary(page).textContent(),
                page.getByText("Filters do not apply to a reference.", { exact: true }).count(),
                rowCount(page),
                calls(page).getByRole("button", { expanded: true }).count(),
                detail(page, seeded.ownerFailure).innerText(),
                Promise.resolve(new URL(page.url()).searchParams.get("q")),
              ]),
            ),
        );
        expect(shown.slice(0, 4)).toEqual(["1 tool call with this reference", 1, 1, 1]);
        expect(shown[4]).toContain("Failure\nThe tool reported an error.");
        expect(shown[4]).toContain(seeded.ownerFailure);
        expect(shown[5]).toBe(seeded.ownerFailure);
        yield* browser.checkpoint("One call by its reference");
        expect(
          yield* browser.use("Copy the reference", (page) =>
            detail(page, seeded.ownerFailure)
              .getByRole("button", { name: "Copy reference", exact: true })
              .click()
              .then(() => page.evaluate(() => navigator.clipboard.readText())),
          ),
        ).toBe(seeded.ownerFailure);

        // A call made by a program narrows the list to that program's run.
        yield* browser.use("Paste the program's reference", (page) =>
          page
            .getByRole("textbox", { name: "Search or paste a reference", exact: true })
            .fill(seeded.runFailure),
        );
        yield* browser.use("Show the run", (page) =>
          detail(page, seeded.runFailure)
            .getByText("One of 3 calls made by the same program.", { exact: false })
            .waitFor()
            .then(() =>
              detail(page, seeded.runFailure)
                .getByRole("button", { name: "Show the run", exact: true })
                .click(),
            ),
        );
        const run = yield* browser.use("The run's calls are listed", (page) =>
          summaryReads(page, "3 tool calls in the last 7 days").then((text) =>
            Promise.all([
              Promise.resolve(text),
              rowCount(page),
              page.getByRole("button", { name: "Remove filter One run", exact: true }).count(),
              page.getByRole("textbox", { name: "Search or paste a reference" }).inputValue(),
              Promise.resolve([...new URL(page.url()).searchParams.keys()]),
            ]),
          ),
        );
        // The member filter the reference ignored did not choose this call, so it is gone too.
        expect(run).toEqual(["3 tool calls in the last 7 days", 3, 1, "", ["run"]]);
        yield* browser.checkpoint("One program's run");

        // On a phone, a referenced call's fields line up with their labels.
        yield* browser.use("Use a phone viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.use("Open the program's call by its address", (page) =>
          page.goto(`/org/${slug}/activity?q=${seeded.runFailure}`),
        );
        const offsets = yield* browser.use("Measure the reference and session rows", (page) => {
          const region = detail(page, seeded.runFailure);
          return region
            .waitFor()
            .then(() =>
              Promise.all([
                misalignment(
                  region,
                  "Reference",
                  region.getByText(seeded.runFailure, { exact: true }),
                ),
                misalignment(
                  region,
                  "MCP session",
                  region.getByRole("button", { name: "Show this session's calls", exact: true }),
                ),
                misalignment(region, "Duration", region.locator("dt:has-text('Duration') + dd")),
              ]),
            );
        });
        for (const [label, offset] of [
          ["Reference", offsets[0]],
          ["MCP session", offsets[1]],
          ["Duration", offsets[2]],
        ] as const)
          expect(offset, `${label} lines up with its label`).toBeLessThanOrEqual(3);
        // A phone has no room beside the menu, so a filter's choices replace the filters, and
        // step back to them by an item that says so.
        const back = yield* browser.use("Step back from a filter", (page) =>
          openFilter(page, "Status").then(() =>
            page
              .getByRole("menuitem", { name: "Status, back to filters", exact: true })
              .innerText()
              .then((text) =>
                page
                  .getByRole("menuitem", { name: "Status, back to filters", exact: true })
                  .click()
                  .then(() => page.getByRole("group", { name: "Filters" }).waitFor())
                  .then(() => text),
              ),
          ),
        );
        expect(back).toBe("Status");
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));
        yield* browser.checkpoint("A program's call on a phone");
        yield* browser.use("Open the member's 403 by its address", (page) =>
          page.goto(`/org/${slug}/activity?q=${seeded.memberForbidden}&status=succeeded`),
        );
        expect(
          yield* browser.use("The failure names the service's status", (page) =>
            detail(page, seeded.memberForbidden)
              .getByText(`${seeded.app.name} returned 403.`, { exact: true })
              .count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("A service's refusal on a phone");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogPageRefreshFailure.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        yield* seedCalls;
        yield* browser.login(actors.admin);
        yield* browser.use("Open Activity", (page) =>
          page.goto(`/org/${actors.organization.slug}/activity`),
        );
        const everyCall = "8 tool calls in the last 7 days";
        expect(
          yield* browser.use("The list shows every call", (page) => summaryReads(page, everyCall)),
        ).toBe(everyCall);

        // The list's next read is refused, as the log refuses a read that takes too long.
        const list = /\/tool-calls\?/u;
        yield* browser.use("Refuse the list's reads", (page) =>
          page.route(list, (route) =>
            route.fulfill({ status: 503, json: { _tag: "ToolCallLogBusy" } }),
          ),
        );
        const failure = (page: Page) =>
          page.getByRole("heading", { name: "Tool calls took too long to read", exact: true });
        yield* browser.use("Return to the tab, which reads the list again", (page) =>
          page
            .evaluate(() =>
              document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
            )
            .then(() => failure(page).waitFor()),
        );
        // The calls already read stay, under the failure.
        expect(yield* browser.use("Count the rows", rowCount)).toBe(8);
        expect(yield* browser.use("Read the summary", (page) => summary(page).textContent())).toBe(
          everyCall,
        );
        yield* browser.checkpoint("A failed read above the calls already read");

        yield* browser.use("Answer the list's reads again", (page) => page.unroute(list));
        yield* browser.use("Try again", (page) =>
          page
            .getByRole("button", { name: "Try again", exact: true })
            .click()
            .then(() => failure(page).waitFor({ state: "detached" })),
        );
        expect(yield* browser.use("Count the rows", rowCount)).toBe(8);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogPageMember.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const seeded = yield* seedCalls;
        yield* browser.login(actors.member);
        yield* browser.use("Open Activity", (page) =>
          page.goto(`/org/${actors.organization.slug}/activity`),
        );
        expect(
          yield* browser.use("The member's own calls are listed", (page) =>
            summaryReads(page, "3 tool calls by you in the last 7 days"),
          ),
        ).toBe("3 tool calls by you in the last 7 days");
        expect(yield* browser.use("Count the rows", rowCount)).toBe(3);
        const filters = yield* browser.use("Open the Filter menu", (page) =>
          page
            .getByRole("button", { name: "Filter", exact: true })
            .click()
            .then(() =>
              page.getByRole("group", { name: "Filters" }).getByRole("menuitem").allInnerTexts(),
            ),
        );
        expect(filters.some((label) => label.startsWith("Member"))).toBe(false);
        expect(filters.some((label) => label.startsWith("Status"))).toBe(true);
        yield* browser.checkpoint("A member's filters");
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Paste the owner's reference", (page) =>
          page
            .getByRole("textbox", { name: "Search or paste a reference", exact: true })
            .fill(seeded.ownerFailure),
        );
        expect(
          yield* browser.use("Another member's call is not found", (page) =>
            summaryReads(page, "No tool call has this reference"),
          ),
        ).toBe("No tool call has this reference");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogRunner.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const { app } = yield* deployApp;
        const slug = actors.organization.slug;
        yield* browser.login(actors.owner);
        yield* browser.use("Allow the page to copy", (page) =>
          page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
        );
        // Opening the tool and running it are separate steps, so the run waits for the page to
        // respond to input.
        const run = (tool: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Open ${tool}`, (page) =>
              page.goto(`/org/${slug}/apps/${app.id}?view=tools&tool=${tool}`),
            );
            yield* browser.use(`Run ${tool}`, (page) =>
              page
                .getByLabel("Text", { exact: true })
                .fill("from the runner")
                .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
            );
          });
        const region = (page: Page) =>
          page.getByRole("region", { name: "Call reference", exact: true });

        // A successful run has no reference.
        yield* run("echo");
        expect(
          yield* browser.use("The result shows without a reference", (page) =>
            page
              .getByRole("region", { name: "Tool result", exact: true })
              .waitFor()
              .then(() => region(page).count()),
          ),
        ).toBe(0);

        // A failed run shows the call's reference beside the error, and copies it.
        yield* run("explode");
        const shown = yield* browser.use("The failure shows its reference", (page) =>
          region(page)
            .waitFor()
            .then(() => region(page).locator("code").textContent()),
        );
        expect(shown).toMatch(reference);
        yield* browser.checkpoint("A failed run's reference");
        expect(
          yield* browser.use("Copy the call reference", (page) =>
            region(page)
              .getByRole("button", { name: "Copy call reference", exact: true })
              .click()
              .then(() => page.evaluate(() => navigator.clipboard.readText())),
          ),
        ).toBe(shown);

        // That reference opens the same call on the Activity page.
        yield* browser.use("Open Activity with the reference", (page) =>
          page.goto(`/org/${slug}/activity?q=${shown ?? ""}`),
        );
        const detail = yield* browser.use("The call opens", (page) => {
          const opened = page.getByRole("region", { name: `Details of ${shown ?? ""}` });
          return opened.waitFor().then(() => opened.innerText());
        });
        expect(detail).toContain("Made from\nThe dashboard");
        expect(detail).toContain("Failure\nThe tool reported an error.");
        expect(detail).toContain(`explode\n${app.name}`);
        yield* browser.checkpoint("The runner's call in Activity");
      }),
    ),
  );
});
