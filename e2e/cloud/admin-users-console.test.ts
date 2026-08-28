// Cloud-only: the admin Users PAGE — the console surface over `/api/admin/users*`.
//
// The sibling `admin-users.test.ts` pins the API's guarantees. This one pins
// what an operator actually sees, which the API scenario cannot: that the page
// renders every member of the workspace, that each row's connection summary
// distinguishes connected from merely available, that opening a user shows that
// user's own connections with their health, and — the failure path that matters
// most here — that a plain member who reaches the URL is told they don't have
// access rather than shown an empty workspace.
//
// Two members are built through the REAL flows (login → create-organization →
// invite → accept-invitation, in `./support/session`). Each connects a Personal
// credential; the plain member's Workspace attempt is refused, so the directory
// and connection UI prove the owner-aware permission boundary together.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { accountIdOf, forBrowser, joinOrg } from "./support/session";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

declare global {
  interface Window {
    // The copy assertions stash what the page handed to the clipboard here, so
    // it can be read back out of the browser context without needing a
    // clipboard-read permission a headless context won't grant.
    __e2eCopied?: Array<string>;
  }
}

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");
const INTEGRATION_TITLE = "Ping API";

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: INTEGRATION_TITLE, version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

/** Registers a fresh apiKey-authenticated integration for connections to bind to. */
const registerIntegration = (client: Client, label: string) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`${label}-${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999", // never contacted during registration
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });
    return slug;
  });

const freshConnectionName = () => ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

scenario(
  "Admin · the Users page shows every member and what each has connected, and refuses a plain member",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);

    const adminClient = yield* apiClient(api, admin);
    const memberClient = yield* apiClient(api, member);
    const adminId = yield* accountIdOf(target, admin);
    const memberId = yield* accountIdOf(target, member);

    // Two integrations so the member's summary has a real zero-of-two state.
    const connectedIntegration = yield* registerIntegration(adminClient, "admin-ui-conn");
    const availableIntegration = yield* registerIntegration(adminClient, "admin-ui-avail");
    const adminConnection = freshConnectionName();
    const memberConnection = freshConnectionName();

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Both roles may store Personal credentials. A member cannot promote
        // theirs into a Workspace credential by bypassing the owner picker.
        yield* adminClient.connections.create({
          payload: {
            owner: "user",
            name: adminConnection,
            integration: connectedIntegration,
            template: TEMPLATE_API_KEY,
            value: "admin-personal-token",
          },
        });
        const workspaceRefusal = yield* memberClient.connections
          .create({
            payload: {
              owner: "org",
              name: memberConnection,
              integration: connectedIntegration,
              template: TEMPLATE_API_KEY,
              value: "member-personal-token",
            },
          })
          .pipe(Effect.flip);
        expect(workspaceRefusal).toMatchObject({ _tag: "OrgWriteDeniedError" });
        yield* memberClient.connections.create({
          payload: {
            owner: "user",
            name: memberConnection,
            integration: connectedIntegration,
            template: TEMPLATE_API_KEY,
            value: "member-personal-token",
          },
        });

        // ── The admin's view ────────────────────────────────────────────────
        yield* browser.session(forBrowser(admin), async ({ page, step }) => {
          let slug = "";

          await step("Land in the workspace and canonicalize onto the org slug", async () => {
            await visit(page, "/");
            await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
              timeout: 30_000,
            });
            slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
            expect(slug, "the URL settled on an org slug").not.toBe("");
          });

          await step("Open Users from the sidebar", async () => {
            // The section is admin-only, so an admin must actually see the link
            // — reaching the page by URL would not prove the nav gate opened.
            await page.getByRole("link", { name: "Users" }).click();
            await page.waitForURL((url) => url.pathname === `/${slug}/users`, { timeout: 30_000 });
            await page.locator("[data-slot='admin-users-table']").waitFor({ timeout: 30_000 });
          });

          await step("Both members of the workspace are listed", async () => {
            const rows = page.locator("[data-slot='admin-user-row']");
            await rows.first().waitFor({ timeout: 30_000 });
            // The id is opaque and rendered shortened, so the row's full value
            // lives in the title the operator hovers for.
            const ids = await rows
              .locator("[data-slot='admin-user-id']")
              .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("title") ?? ""),
              );
            expect(ids, "the admin's own row is listed").toContain(adminId);
            expect(
              ids,
              "the invited member is listed too, though the admin's product view cannot see them",
            ).toContain(memberId);

            // The host joins identity server-side, so an operator reads people
            // by name rather than by opaque id. The emails are the ones these
            // identities were actually minted with — asserting the seeded values
            // is what proves the join key lines up, since a wrong key would
            // leave every row unnamed while the id assertions above still pass.
            const names = await rows
              .locator("[data-slot='admin-user-name']")
              .evaluateAll((elements) => elements.map((element) => element.textContent ?? ""));
            expect(names, "the admin's row leads with their email").toContain(
              admin.credentials?.email,
            );
            expect(names, "and the invited member's with theirs").toContain(
              member.credentials?.email,
            );
          });

          await step("Each row summarizes connected vs available integrations", async () => {
            const memberRow = page
              .locator("[data-slot='admin-user-row']")
              .filter({ has: page.locator(`[data-slot='admin-user-id'][title='${memberId}']`) });
            await memberRow.waitFor({ state: "visible", timeout: 30_000 });
            // A fresh cloud org's catalog is exactly the two integrations this
            // scenario registered: the built-in Executor integration is not
            // connectable, so it is neither a slot nor a denominator. The
            // denominator is therefore pinned, not read — a third slot here
            // would mean the built-in leaked back into the view.
            const summary = memberRow.locator("[data-slot='admin-user-connection-count']");
            await summary.waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await summary.textContent(),
              "one connectable integration is connected, with the built-in out of both numbers",
            ).toBe("1/2");
            expect(
              await memberRow.locator("[data-integration='executor']").count(),
              "the built-in integration has no connect flow, so it gets no slot",
            ).toBe(0);
            expect(
              await memberRow
                .locator(`[data-integration='${connectedIntegration}'][data-connected='true']`)
                .count(),
              "the member's Personal credential is lit in their summary",
            ).toBe(1);
            expect(
              await memberRow
                .locator(`[data-integration='${availableIntegration}'][data-connected='false']`)
                .count(),
              "the one they haven't connected still has a slot — that absence is the view",
            ).toBe(1);
          });

          await step("Open the member's detail and confirm their Personal connection", async () => {
            await page
              .locator("[data-slot='admin-user-row']")
              .filter({ has: page.locator(`[data-slot='admin-user-id'][title='${memberId}']`) })
              .click();
            const detail = page.getByRole("dialog");
            await detail.waitFor({ state: "visible", timeout: 30_000 });

            await detail
              .getByText(memberConnection, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });
            // The other member's credential is not this member's business.
            expect(
              await detail.getByText(adminConnection, { exact: true }).count(),
              "one user's detail never shows another user's connection",
            ).toBe(0);
          });

          await step("The detail header copies the member's email and their id", async () => {
            const detail = page.getByRole("dialog");
            // Record what reaches the clipboard rather than reading it back:
            // a headless context grants no clipboard-read permission, and the
            // assertion is about what the button hands over, not about the
            // browser's store.
            await page.evaluate(() => {
              const copied: Array<string> = [];
              window.__e2eCopied = copied;
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                get: () => ({
                  writeText: (text: string) => {
                    copied.push(text);
                    return Promise.resolve();
                  },
                }),
              });
            });

            // Two buttons, not one: the email is what an operator pastes into a
            // mail client, the id is what they paste into a log search.
            await detail.getByRole("button", { name: "Copy email" }).click();
            await detail.getByRole("button", { name: "Copy ID" }).click();

            const copied = await page.evaluate(() => window.__e2eCopied ?? []);
            expect(
              copied,
              "the email button copies the address the member signed up with",
            ).toContain(member.credentials?.email);
            expect(copied, "and the id button copies the opaque principal id").toContain(memberId);
          });

          await step("The not-connected integration offers a copyable connect link", async () => {
            const detail = page.getByRole("dialog");
            const origin = new URL(target.baseUrl).origin;
            // The link carries THIS admin's org slug. A recipient who belongs
            // to several orgs would otherwise resolve the bare form against
            // their default org and connect in the wrong workspace. That
            // multi-org round trip is its own scenario
            // (`connect-link-multi-org.test.ts`), which needs a second org to
            // land in by mistake; here the concern is what this page RENDERS,
            // plus that the rendered link actually resolves (below).
            await detail
              .getByText(`${origin}/${slug}/connect/${availableIntegration}`, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await detail
                .getByText(`${origin}/connect/${availableIntegration}`, { exact: true })
                .count(),
              "the org-free form is never rendered on a host that has orgs",
            ).toBe(0);
            // Only the unconnected integration is available; the member's
            // Personal connection consumes the other slot. The built-in still
            // offers no link at all.
            expect(
              await detail.getByRole("button", { name: "Copy link" }).count(),
              "one link for the not-connected integration, and none for the built-in",
            ).toBe(1);
            expect(
              await detail.getByText("/connect/executor", { exact: false }).count(),
              "the built-in integration is never offered as a connect link",
            ).toBe(0);
          });

          await step("The rendered connect link actually resolves", async () => {
            // Following the link the page just rendered, rather than only
            // reading it back. A rendered string proves the page composed a URL;
            // it cannot tell a working link from a 404 — which is the failure an
            // operator would discover only after sending it to someone.
            const origin = new URL(target.baseUrl).origin;
            await page.goto(`${origin}/${slug}/connect/${availableIntegration}`, {
              waitUntil: "domcontentloaded",
            });
            // It forwards into that integration's own detail route with the
            // add-account handoff, still inside this admin's org.
            await page.waitForURL(
              (url) => url.pathname === `/${slug}/integrations/${availableIntegration}`,
              { timeout: 30_000 },
            );
            expect(
              new URL(page.url()).searchParams.get("addAccount"),
              "the link lands in the connect flow, not just on the page",
            ).toBe("1");
          });
        });

        // ── The plain member's view ─────────────────────────────────────────
        yield* browser.session(forBrowser(member), async ({ page, step }) => {
          let slug = "";

          await step("Sign in as a plain member of the same workspace", async () => {
            await visit(page, "/");
            await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
              timeout: 30_000,
            });
            slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
            expect(slug, "the member landed in the workspace").not.toBe("");
          });

          await step("The Users section is not offered to them", async () => {
            await page
              .getByRole("link", { name: "Integrations" })
              .first()
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await page.getByRole("link", { name: "Users" }).count(),
              "a plain member is not shown a section that would only refuse them",
            ).toBe(0);
          });

          await step(
            "Reaching the URL directly says no access, not an empty workspace",
            async () => {
              await visit(page, `/${slug}/users`);
              // The denial is the assertion: an empty table here would misreport
              // a populated workspace as having no users.
              await page
                .getByText("You don't have access to this workspace's users")
                .waitFor({ state: "visible", timeout: 30_000 });
              expect(
                await page.locator("[data-slot='admin-users-table']").count(),
                "the refusal replaces the table rather than rendering it empty",
              ).toBe(0);
              expect(
                await page.getByText(adminId, { exact: true }).count(),
                "no other member's identity leaks to a refused viewer",
              ).toBe(0);
            },
          );

          await step(
            "The member can add Personal connections without a scope dropdown",
            async () => {
              await visit(page, `/${slug}/integrations/${availableIntegration}?tab=accounts`);
              const add = page.getByRole("button", { name: "Add connection" });
              await add.waitFor({ state: "visible", timeout: 30_000 });
              await add.click();
              const dialog = page.getByRole("dialog");
              await dialog
                .getByText(`Add connection · ${INTEGRATION_TITLE}`, { exact: false })
                .waitFor({ state: "visible", timeout: 30_000 });
              expect(
                await dialog.getByText("Workspace", { exact: true }).count(),
                "the member is forced to Personal rather than offered a scope picker",
              ).toBe(0);
              await page.keyboard.press("Escape");
            },
          );

          await step("Their connect deep link opens the Personal add flow", async () => {
            await visit(page, `/${slug}/connect/${availableIntegration}`);
            await page.waitForURL(
              (url) => url.pathname === `/${slug}/integrations/${availableIntegration}`,
              { timeout: 30_000 },
            );
            expect(new URL(page.url()).searchParams.get("addAccount")).toBe("1");
            await page
              .getByRole("dialog")
              .getByText(`Add connection · ${INTEGRATION_TITLE}`, { exact: false })
              .waitFor({ state: "visible", timeout: 30_000 });
          });
        });
      }),
      Effect.all(
        [
          adminClient.connections
            .remove({
              params: { owner: "user", integration: connectedIntegration, name: adminConnection },
            })
            .pipe(Effect.ignore),
          memberClient.connections
            .remove({
              params: { owner: "user", integration: connectedIntegration, name: memberConnection },
            })
            .pipe(Effect.ignore),
          adminClient.openapi
            .removeSpec({ params: { slug: connectedIntegration } })
            .pipe(Effect.ignore),
          adminClient.openapi
            .removeSpec({ params: { slug: availableIntegration } })
            .pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);
