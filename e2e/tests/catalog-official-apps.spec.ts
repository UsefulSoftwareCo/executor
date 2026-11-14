/** Add app lists Executor's official apps and installs one's own source as a copy. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Inventory } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { officialApps } from "../support/public-catalogs.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const Entries = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    package: Schema.String,
    name: Schema.String,
    auth: Schema.Array(
      Schema.Struct({
        method: Schema.String,
        kind: Schema.String,
        label: Schema.optionalKey(Schema.String),
      }),
    ),
    icons: Schema.Array(
      Schema.Struct({ src: Schema.String, theme: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
/** A listing whose feed was read: the official apps are all there. */
const Catalog = Schema.Struct({
  apps: Entries,
  feed: Schema.Struct({ status: Schema.Literal("listed") }),
});
const Installed = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  activeVersion: Schema.String,
  copiedFrom: Schema.Struct({
    name: Schema.String,
    reference: Schema.String,
    commit: Schema.Null,
  }),
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.Unknown) }),
});
const Source = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.optional(Schema.String) }),
  ),
});
const Rejected = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("Official app catalog", (it) => {
  it.effect(scenarios.catalogOfficialApps.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const { apps: entries } = yield* body(
          Catalog,
          yield* api.request(actors.owner, "GET", "/api/catalog"),
        );
        // The built-in Executor app comes first, then the feed's apps in its order.
        expect(entries.map((entry) => entry.name)).toEqual([
          "Executor",
          officialApps.mail.name,
          officialApps.tracker.name,
          officialApps.mismatched.name,
        ]);
        const mail = entries.find((entry) => entry.id === officialApps.mail.id);
        if (mail === undefined) return yield* Effect.die("The official mail fixture is missing");
        // Icons are the package's own files, resolved against the feed's address.
        expect(mail.icons.map((icon) => [icon.theme, new URL(icon.src).pathname])).toEqual([
          ["light", "/catalog/icons/mail-light.svg"],
          ["dark", "/catalog/icons/mail-dark.svg"],
        ]);
        expect(mail.auth).toEqual([{ method: "apiKey", kind: "secrets", label: "API key" }]);

        // A listing whose source names another package is refused before anything is created.
        const refusedName = `Mismatched ${randomUUID().slice(0, 8)}`;
        const refused = yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
          entry: officialApps.mismatched.id,
          name: refusedName,
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect((yield* body(Rejected, refused)).code).toBe("invalid_source");
        expect(
          (yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          )).apps.map((app) => app.name),
        ).not.toContain(refusedName);

        // An official app installs its own source as a copy and keeps its package name.
        const trackerName = `Tracker ${randomUUID().slice(0, 8)}`;
        const tracker = yield* body(
          Installed,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
            entry: officialApps.tracker.id,
            name: trackerName,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${tracker.id}`).pipe(Effect.orDie),
        );
        expect(tracker.name).toBe(trackerName);
        expect(tracker.copiedFrom.name).toBe(officialApps.tracker.package);
        expect(new URL(tracker.copiedFrom.reference).pathname).toBe(
          `/catalog/${officialApps.tracker.source}`,
        );
        expect(Object.keys(tracker.requirements.accounts)).toEqual(["tracker"]);
        const source = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${tracker.id}/source`),
        );
        expect(
          JSON.parse(source.files.find((file) => file.path === "package.json")?.content ?? "{}")
            .name,
        ).toBe(officialApps.tracker.package);

        // An unrelated app already holds the mail app's catalog name, so adding it meets a conflict.
        const held = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: officialApps.mail.name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Holder fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
            },
            appsManifest,
          ],
        });
        expect(held.status, JSON.stringify(held.body)).toBe(200);
        const holder = yield* body(App, held);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${holder.id}`).pipe(Effect.orDie),
        );

        const row = (page: Page, name: string) => page.locator(".catalog-row", { hasText: name });
        yield* browser.login(actors.owner);

        // The tracker's source declares no icons, so its page shows the catalog entry's icon, found
        // by the package it was copied from. Until the catalog answers it shows a neutral icon,
        // never its OAuth host's domain logo.
        const catalog = yield* holdQuery(["/api/catalog"], "continue");
        const logos: string[] = [];
        yield* browser.use("Watch for domain logos", (page) => {
          page.on("request", (request) => {
            if (new URL(request.url()).hostname === "integrations.sh") logos.push(request.url());
          });
          return Promise.resolve();
        });
        yield* browser.use("Open the tracker's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${tracker.id}?view=accounts`),
        );
        yield* catalog.requested;
        const heading = (page: Page) =>
          page.locator("header", {
            has: page.getByRole("heading", { level: 1, name: trackerName }),
          });
        const provider = (page: Page) =>
          page.getByRole("region", { name: officialApps.tracker.name, exact: true });
        const images = yield* browser.use("The icons wait for the catalog", (page) =>
          heading(page)
            .locator('.provider-icon [data-icon="loading"]')
            .waitFor()
            .then(() =>
              Promise.all([
                heading(page).locator(".provider-icon img").count(),
                provider(page).locator(".provider-icon img").count(),
              ]),
            ),
        );
        expect(images).toEqual([0, 0]);
        yield* browser.checkpoint("The tracker's icons wait for the catalog");
        yield* catalog.release;
        const trackerIcon = `img[data-icon="app"][src$="/catalog/icons/tracker.svg"]`;
        yield* browser.use("The heading shows the catalog icon", (page) =>
          heading(page).locator(trackerIcon).waitFor(),
        );
        yield* browser.use("The provider row shows the catalog icon", (page) =>
          provider(page).locator(trackerIcon).waitFor(),
        );
        yield* browser.checkpoint("The tracker shows its catalog icon");
        expect(logos).toEqual([]);
        // Add app keeps its layout while the catalog loads: the placeholders take the loaded
        // toolbar's and rows' places, so nothing moves when the catalog answers.
        const layout = (page: Page, row: string) =>
          Promise.all(
            [".list-toolbar", row].map((selector) =>
              page
                .locator(selector)
                .first()
                .boundingBox()
                .then((box) => box && [box.x, box.y, box.width, box.height]),
            ),
          );
        const pending = yield* holdQuery(["/api/catalog"], "continue");
        yield* browser.use("Open Add app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add`),
        );
        yield* pending.requested;
        const placeholder = yield* browser.use("Add app holds its layout while loading", (page) =>
          page
            .getByRole("status", { name: "Loading apps" })
            .waitFor()
            .then(() => layout(page, '[aria-label="Loading apps"] > div')),
        );
        yield* browser.checkpoint("Add app holds its layout while the catalog loads");
        yield* pending.release;
        const loaded = yield* browser.use("The catalog fills the same places", (page) =>
          page
            .locator(".catalog-row")
            .first()
            .waitFor()
            .then(() => layout(page, ".catalog-row")),
        );
        expect(loaded).toEqual(placeholder);
        yield* browser.use("Search the catalog", (page) =>
          page.getByPlaceholder("Search apps…").fill("synthetic"),
        );
        yield* browser.use("Official apps are listed with their own icons", (page) =>
          row(page, officialApps.mail.name)
            .locator(`img[src$="/catalog/icons/mail-light.svg"]`)
            .waitFor(),
        );
        // The tracker was installed before this visit, so its row offers Open instead of Add.
        yield* browser.use("An installed app offers Open", (page) =>
          row(page, officialApps.tracker.name).getByRole("link", { name: "Open" }).waitFor(),
        );
        yield* browser.use("An app not yet added offers Add", (page) =>
          row(page, officialApps.mail.name)
            .getByRole("button", { name: `Add ${officialApps.mail.name}`, exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint("Add app lists official apps");

        // The taken name asks for another one.
        yield* browser.use("Add the mail app", (page) =>
          page.getByRole("button", { name: `Add ${officialApps.mail.name}`, exact: true }).click(),
        );
        yield* browser.use("The name conflict asks for another name", (page) =>
          page.getByRole("dialog", { name: "Choose another name" }).waitFor(),
        );
        expect(
          yield* browser.use("The taken name is prefilled", (page) =>
            page.getByLabel("App name", { exact: true }).inputValue(),
          ),
        ).toBe(officialApps.mail.name);
        yield* browser.checkpoint("A taken name asks for another one");
        const mailName = `Mail ${randomUUID().slice(0, 8)}`;
        yield* browser.use("Name the app", (page) =>
          page.getByLabel("App name", { exact: true }).fill(mailName),
        );
        yield* browser.use("Add the renamed app", (page) =>
          page.getByRole("dialog").getByRole("button", { name: "Add app", exact: true }).click(),
        );
        // The page stays put with its search; the row now offers Open.
        yield* browser.use("The mail row offers Open", (page) =>
          row(page, officialApps.mail.name).getByRole("link", { name: "Open" }).waitFor(),
        );
        const stayed = yield* browser.use("The page and its search stay", (page) =>
          page
            .getByPlaceholder("Search apps…")
            .inputValue()
            .then((search) => ({ pathname: new URL(page.url()).pathname, search })),
        );
        expect(stayed).toEqual({
          pathname: `/org/${actors.organization.slug}/apps/add`,
          search: "synthetic",
        });
        const added = (yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        )).apps.find((app) => app.name === mailName);
        if (added === undefined) return yield* Effect.die("The added mail app is missing");
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${added.id}`).pipe(Effect.orDie),
        );
        yield* browser.checkpoint("The added app offers Open on the same page");

        // A fresh visit still knows both apps are installed.
        yield* browser.use("Reload the app catalog", (page) => page.reload());
        yield* browser.use("Search the catalog again", (page) =>
          page.getByPlaceholder("Search apps…").fill("synthetic"),
        );
        yield* browser.use("The tracker row offers Open", (page) =>
          row(page, officialApps.tracker.name).getByRole("link", { name: "Open" }).waitFor(),
        );
        yield* browser.use("The mail row still offers Open", (page) =>
          row(page, officialApps.mail.name).getByRole("link", { name: "Open" }).waitFor(),
        );
        yield* browser.use("Open the added app", (page) =>
          row(page, officialApps.mail.name).getByRole("link", { name: "Open" }).click(),
        );
        yield* browser.use("Account setup follows", (page) =>
          page.waitForURL(`**/apps/${added.id}?view=accounts`),
        );
        yield* browser.checkpoint("Open leads to the added app's account setup");

        // Add app offers making your own app first, then the app catalog.
        yield* browser.use("Return to Apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        const choose = (choice: string) =>
          browser.use(`Choose ${choice}`, (page) =>
            page
              .getByRole("button", { name: "Add app", exact: true })
              .click()
              .then(() => page.getByRole("menuitem", { name: new RegExp(`^${choice}`) }).click()),
          );
        yield* browser.use("Open Add app", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).click(),
        );
        const menu = yield* browser.use("Add app lists the ways to add an app", (page) =>
          page
            .getByRole("menuitem")
            .first()
            .waitFor()
            .then(() =>
              Promise.all([
                page.getByRole("menu").getByText("Create your own", { exact: true }).count(),
                page.getByRole("menuitem").locator(".font-medium").allTextContents(),
              ]),
            ),
        );
        expect(menu).toEqual([1, ["From scratch", "From an MCP server", "Browse app catalog"]]);
        yield* browser.checkpoint("Add app puts creating your own before the app catalog");
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));

        yield* choose("From scratch");
        yield* browser.use("Describe the app", (page) =>
          page
            .getByRole("dialog", { name: "Create from scratch" })
            .getByLabel("What should it do?")
            .fill("Summarize my Linear issues every Monday."),
        );
        const prompt = yield* browser.use("The prompt carries the description", (page) =>
          page.getByRole("region", { name: "Send this to your agent" }).textContent(),
        );
        expect(prompt).toContain("What it should do: Summarize my Linear issues every Monday.");
        yield* browser.checkpoint("From scratch hands the description to the agent");
        yield* browser.use("Close the From scratch dialog", (page) =>
          page.keyboard.press("Escape"),
        );

        // URL import is for MCP servers only; anything else, such as OpenAPI, starts from scratch.
        yield* choose("From an MCP server");
        const mcp = yield* browser.use("The MCP server dialog offers one URL form", (page) => {
          const dialog = page.getByRole("dialog", { name: "Create from an MCP server" });
          return dialog
            .getByLabel("MCP server URL", { exact: true })
            .waitFor()
            .then(() =>
              Promise.all([
                dialog.getByRole("textbox").count(),
                dialog.getByRole("link").count(),
                dialog.getByText(/build an app from it/i).count(),
              ]),
            );
        });
        expect(mcp).toEqual([2, 0, 0]);
        yield* browser.checkpoint("The MCP server dialog imports MCP URLs only");
        yield* browser.use("Send other services to From scratch", (page) =>
          page
            .getByRole("button", { name: "Start from scratch", exact: true })
            .click()
            .then(() => page.getByRole("dialog", { name: "Create from scratch" }).waitFor()),
        );
        yield* browser.use("Close the From scratch dialog", (page) =>
          page.keyboard.press("Escape"),
        );

        yield* choose("Browse app catalog");
        yield* browser.use("Browse app catalog opens the catalog", (page) =>
          page
            .waitForURL(`**/org/${actors.organization.slug}/apps/add`)
            .then(() => page.getByRole("heading", { name: "App catalog", exact: true }).waitFor()),
        );
        const makeYourOwn = yield* browser.use("The catalog offers Make your own twice", (page) =>
          page.getByRole("button", { name: "Make your own", exact: true }).count(),
        );
        expect(makeYourOwn).toBe(2);
        yield* browser.checkpoint(
          "App catalog offers Make your own in its header and below the apps",
        );
        yield* browser.use("The header's Make your own opens the same create choices", (page) =>
          page
            .getByRole("button", { name: "Make your own", exact: true })
            .first()
            .click()
            .then(() => page.getByRole("menuitem", { name: /^From an MCP server/ }).click())
            .then(() => page.getByRole("dialog", { name: "Create from an MCP server" }).waitFor()),
        );
        yield* browser.checkpoint("The catalog's Make your own opens the MCP server dialog");
        yield* browser.use("Close the MCP server dialog", (page) => page.keyboard.press("Escape"));
        yield* browser.use("Search for a missing app", (page) =>
          page.getByPlaceholder("Search apps…").fill("no such service"),
        );
        const noResults = yield* browser.use("No results still offer Make your own", (page) =>
          page
            .getByRole("heading", { name: "No matching apps", exact: true })
            .waitFor()
            .then(() =>
              page.getByRole("button", { name: "Make your own", exact: true }).last().waitFor(),
            )
            .then(() => page.getByRole("button", { name: "Make your own", exact: true }).count()),
        );
        expect(noResults).toBe(2);
        yield* browser.checkpoint("No results offer Make your own");
      }),
    ),
  );
});
