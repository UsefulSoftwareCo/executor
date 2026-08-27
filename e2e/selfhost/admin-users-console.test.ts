// Selfhost-only (browser): the admin Users page against the OTHER auth model.
//
// Cloud gates this plane on a WorkOS `admin` membership; self-host gates it on
// a Better Auth `owner`/`admin` member. The console is shared, so the same page
// must open for the instance owner and refuse an invited plain member — that
// second role vocabulary is exactly what the cloud scenario cannot cover.
//
// Selfhost identities are shared across scenarios (one bootstrap admin, one
// org), so this asserts "contains mine" rather than global counts, and every
// resource it creates is prefixed.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { createInvitedIdentity } from "../targets/selfhost";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

declare global {
  interface Window {
    // What the page handed to the clipboard through the non-secure-origin
    // execCommand fallback, read back out of the browser context.
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

const registerIntegration = (client: Client, label = "admin-ui-sh") =>
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

scenario(
  "Admin · a self-hosted owner sees the workspace's users; an invited member is refused",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    // The bootstrap identity owns the instance; the invited one is a plain
    // member, which is the Better Auth role the admin plane refuses.
    const owner = yield* target.newIdentity();
    const member = yield* Effect.promise(() =>
      createInvitedIdentity(target.baseUrl, owner, {
        role: "member",
        emailPrefix: "admin-ui-member",
      }),
    );

    const ownerClient = yield* apiClient(api, owner);
    const memberClient = yield* apiClient(api, member);
    const integration = yield* registerIntegration(ownerClient);
    // A second, deliberately unconnected integration, so the member's detail is
    // guaranteed to render at least one connect link to assert the shape of.
    const availableIntegration = yield* registerIntegration(ownerClient, "admin-ui-sh-avail");
    const memberConnection = ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Members may add Personal credentials, but the API refuses the same
        // request in Workspace scope even if they bypass the owner picker.
        const refusal = yield* memberClient.connections
          .create({
            payload: {
              owner: "org",
              name: memberConnection,
              integration,
              template: TEMPLATE_API_KEY,
              value: "member-personal-token",
            },
          })
          .pipe(Effect.flip);
        expect(refusal).toMatchObject({ _tag: "OrgWriteDeniedError" });
        yield* memberClient.connections.create({
          payload: {
            owner: "user",
            name: memberConnection,
            integration,
            template: TEMPLATE_API_KEY,
            value: "member-personal-token",
          },
        });

        yield* browser.session(owner, async ({ page, step }) => {
          await step("Open Users from the sidebar as the instance owner", async () => {
            await visit(page, "/");
            await page
              .locator("nav")
              .getByRole("link", { name: "Users" })
              .first()
              .click({ timeout: 30_000 });
            await page
              .locator("[data-slot='admin-users-table']")
              .waitFor({ state: "visible", timeout: 30_000 });
          });

          await step("The invited member is listed with their Personal connection", async () => {
            // Selfhost shares one org across scenarios, so this asserts the
            // member's own row exists — never a count of the whole instance.
            const row = page
              .locator("[data-slot='admin-user-row']")
              .filter({
                has: page.locator(`[data-integration='${integration}'][data-connected='true']`),
              })
              .first();
            await row.waitFor({ state: "visible", timeout: 30_000 });

            // Better Auth's identity, joined server-side. The join key is the
            // member list's `userId` (the Better Auth user id the subject table
            // records), NOT the organization `member` row id — so asserting the
            // email this identity was actually minted with is what proves the
            // id spaces line up on THIS host's auth model.
            expect(
              await row.locator("[data-slot='admin-user-name']").textContent(),
              "the member's row leads with the email they signed up with",
            ).toBe(member.credentials?.email);

            await row.click();

            const detail = page.getByRole("dialog");
            await detail.waitFor({ state: "visible", timeout: 30_000 });
            await detail
              .getByText(memberConnection, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });
          });

          await step("The detail header copies the member's email and their id", async () => {
            const detail = page.getByRole("dialog");
            // The member's opaque id, from the supporting line the header shows
            // beneath the email.
            const externalId = await detail
              .locator("[data-slot='admin-user-detail-id']")
              .getAttribute("title");
            expect(externalId, "the header carries the opaque principal id").not.toBe("");

            // Self-host is served over plain HTTP — a NON-secure origin, where
            // `navigator.clipboard` does not exist and the copy must go through
            // the execCommand fallback (see @executor-js/react `lib/clipboard`).
            // Record what that path selects, exactly as the api-keys copy test
            // does, so this asserts the real self-host copy path rather than a
            // secure-context one the deployment never takes.
            await page.evaluate(() => {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                get: () => undefined,
              });
              const copied: Array<string> = [];
              window.__e2eCopied = copied;
              const exec = document.execCommand?.bind(document);
              document.execCommand = (command, ...rest) => {
                if (String(command).toLowerCase() === "copy") {
                  copied.push(window.getSelection ? String(window.getSelection()) : "");
                }
                return exec ? exec(command, ...rest) : false;
              };
            });

            await detail.getByRole("button", { name: "Copy email" }).click();
            await detail.getByRole("button", { name: "Copy ID" }).click();

            const copied = await page.evaluate(() => window.__e2eCopied ?? []);
            expect(copied, "the email button copies the member's address").toContain(
              member.credentials?.email,
            );
            expect(copied, "and the id button copies their opaque id").toContain(externalId);
          });

          await step(
            "The built-in integration is never offered as something to connect",
            async () => {
              // It is a static, credential-free source: there is no connect flow
              // to send anyone to, so it is neither a slot nor a link. This is the
              // reported bug — it used to appear under "not connected" with a
              // copyable link to a route that would do nothing.
              const detail = page.getByRole("dialog");
              expect(
                await detail.locator("[data-integration='executor']").count(),
                "the built-in gets no slot in the detail sheet",
              ).toBe(0);
              expect(
                await detail.getByText("/connect/executor", { exact: false }).count(),
                "and no connect link is rendered for it",
              ).toBe(0);
            },
          );

          await step("A connect link is scoped to the org the admin is viewing", async () => {
            // The invariant is a round trip, not a fixed shape: whatever org the
            // console is currently scoped to is the org the link carries, so a
            // recipient cannot be sent into a different workspace than the one
            // the admin was looking at.
            //
            // Self-host DOES have an org segment — it canonicalizes onto a
            // `default` org — so this host exercises the prefixed form just as
            // cloud does. The org-free form is what a host that renders no
            // segment at all would produce, and it is covered by the display
            // unit tests rather than pinned to a host here.
            //
            // The SHAPE of every rendered link is what this step pins; that the
            // link resolves is asserted by following one in the next step, and
            // the multi-org "lands in the sending workspace" round trip is
            // cloud's `connect-link-multi-org.test.ts` (it needs a second org,
            // which self-host's single turnkey org cannot provide).
            const detail = page.getByRole("dialog");
            const origin = new URL(target.baseUrl).origin;
            // The console's own org prefix, read from the URL the page settled
            // on — "" when this host renders no segment.
            const consolePath = new URL(page.url()).pathname;
            const orgPrefix = consolePath.endsWith("/users")
              ? consolePath.slice(0, -"/users".length)
              : "";

            // The integration nobody connected is the one whose link must be here.
            await detail
              .getByText(`${origin}${orgPrefix}/connect/${availableIntegration}`, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });

            // And EVERY rendered link agrees with the console's own scope — one
            // link pointing at another org would silently misroute a recipient.
            const links = await detail
              .locator("[data-slot='admin-user-connect-link']")
              .allTextContents();
            expect(links.length, "the owner sees at least one link to send").toBeGreaterThanOrEqual(
              1,
            );
            for (const link of links) {
              const parsed = new URL(link);
              expect(parsed.origin, `absolute for this deployment: ${link}`).toBe(origin);
              expect(
                parsed.pathname.startsWith(`${orgPrefix}/connect/`),
                `scoped to the console's own org (${orgPrefix || "<none>"}): ${link}`,
              ).toBe(true);
              expect(
                parsed.pathname.slice(`${orgPrefix}/connect/`.length).split("/").length,
                `exactly one slug after /connect/: ${link}`,
              ).toBe(1);
            }
          });

          await step("The rendered connect link actually resolves", async () => {
            // Following the link the page just rendered. A rendered string
            // proves the page composed a URL; it cannot distinguish a working
            // link from a 404 — which an operator would only discover after
            // sending it to someone.
            const origin = new URL(target.baseUrl).origin;
            const consolePath = new URL(page.url()).pathname;
            const orgPrefix = consolePath.endsWith("/users")
              ? consolePath.slice(0, -"/users".length)
              : "";
            await page.goto(`${origin}${orgPrefix}/connect/${availableIntegration}`, {
              waitUntil: "domcontentloaded",
            });
            // It forwards into that integration's own detail route with the
            // add-account handoff, still inside the console's own org.
            await page.waitForURL(
              (url) => url.pathname === `${orgPrefix}/integrations/${availableIntegration}`,
              { timeout: 30_000 },
            );
            expect(
              new URL(page.url()).searchParams.get("addAccount"),
              "the link lands in the connect flow, not just on the page",
            ).toBe("1");
          });
        });

        yield* browser.session(member, async ({ page, step }) => {
          await step("A plain member is not offered the section", async () => {
            await visit(page, "/");
            await page
              .locator("nav")
              .getByRole("link", { name: "Integrations" })
              .first()
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await page.locator("nav").getByRole("link", { name: "Users" }).count(),
              "a plain member is not shown a section that would only refuse them",
            ).toBe(0);
          });

          await step("And reaching the URL directly is refused, not silently empty", async () => {
            await visit(page, "/users");
            await page
              .getByText("You don't have access to this workspace's users")
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await page.locator("[data-slot='admin-users-table']").count(),
              "the refusal replaces the table rather than rendering it empty",
            ).toBe(0);
          });

          await step("A member can add Personal connections without a scope dropdown", async () => {
            await visit(page, `/integrations/${availableIntegration}?tab=accounts`);
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
          });

          await step("A member's connect deep link opens the Personal add flow", async () => {
            await visit(page, `/connect/${availableIntegration}`);
            await page.waitForURL(
              (url) => url.pathname.endsWith(`/integrations/${availableIntegration}`),
              { timeout: 30_000 },
            );
            expect(
              new URL(page.url()).searchParams.get("addAccount"),
              "the deep link enters the member's forced-Personal add flow",
            ).toBe("1");
            await page
              .getByRole("dialog")
              .getByText(`Add connection · ${INTEGRATION_TITLE}`, { exact: false })
              .waitFor({ state: "visible", timeout: 30_000 });
          });
        });
      }),
      Effect.all(
        [
          memberClient.connections
            .remove({ params: { owner: "user", integration, name: memberConnection } })
            .pipe(Effect.ignore),
          ownerClient.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
          ownerClient.openapi
            .removeSpec({ params: { slug: availableIntegration } })
            .pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);
