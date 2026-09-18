import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { Api, Browser } from "./services";
import type { Identity } from "./target";
import { visit } from "./surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Exercise integration creation and member restrictions through the shared console. */
export const integrationCreationPermissions = (admin: Identity, member: Identity) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const { client } = yield* Api;
    const adminClient = yield* client(api, admin);
    const title = `Permissions API ${randomBytes(4).toString("hex")}`;
    const slug = IntegrationSlug.make(title.toLowerCase().replaceAll(" ", "_"));
    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title, version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {},
      components: {
        securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
      },
      security: [{ apiKey: [] }],
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* browser.session(admin, async ({ page, step }) => {
          await step("Admin opens the integration catalog", async () => {
            await visit(page, "/");
            await page.getByRole("button", { name: "Browse integrations", exact: true }).waitFor();
            await page.keyboard.press("ControlOrMeta+k");
            await page.getByRole("option", { name: /^Add OpenAPI/ }).waitFor();
            await page.keyboard.press("Escape");
            await page.getByRole("link", { name: "Add integration", exact: true }).click();
            await page.getByRole("heading", { name: "Add an integration", exact: true }).waitFor();
            await page
              .getByRole("textbox", { name: "Search integrations, or paste a URL" })
              .waitFor();
          });
          await step("Admin creates an integration from the setup form", async () => {
            await visit(page, "/integrations/add/openapi");
            await page.getByPlaceholder("https://api.example.com/openapi.json").fill(spec);
            await page.getByRole("button", { name: "Add integration", exact: true }).click();
            await page.waitForURL((url) => url.pathname.endsWith(`/integrations/${slug}`), {
              timeout: 30_000,
            });
            await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
            await page.getByRole("button", { name: "Delete", exact: true }).waitFor();
          });
        });
        expect(yield* adminClient.integrations.get({ params: { slug } })).toMatchObject({
          name: title,
        });

        yield* browser.session(member, async ({ page, step }) => {
          await step(
            "Member sees disabled creation controls with an admin explanation",
            async () => {
              await visit(page, "/");
              await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor();
              await page.getByTestId(`integration-entry-${slug}`).waitFor();
              const add = page.getByRole("button", { name: "Add integration", exact: true });
              await add.waitFor();
              expect(await add.isDisabled()).toBe(true);
              expect(
                await page
                  .getByRole("button", { name: "Browse integrations", exact: true })
                  .isDisabled(),
              ).toBe(true);
              const hint = page
                .getByRole("group", { name: "Requires a workspace admin" })
                .filter({ has: add });
              await hint.hover();
              await page.getByRole("tooltip", { name: "Requires a workspace admin" }).waitFor();
              await hint.focus();
              const before = page.url();
              await page.keyboard.press("Enter");
              expect(page.url()).toBe(before);
            },
          );
          await step(
            "Member sees disabled add commands and can still find existing integrations",
            async () => {
              await page.keyboard.press("ControlOrMeta+k");
              const palette = page.getByRole("dialog");
              await palette.getByRole("option", { name: new RegExp(title) }).waitFor();
              const addCommand = palette.getByRole("option", { name: /^Add OpenAPI/ });
              await addCommand.waitFor();
              expect(await addCommand.getAttribute("aria-disabled")).toBe("true");
              expect(await addCommand.textContent()).toContain("Admin only");
              await page.keyboard.press("Escape");
            },
          );
          await step("Member sees disabled Edit and Delete actions", async () => {
            await page.getByTestId(`integration-entry-${slug}`).click();
            await page.getByRole("button", { name: "Add connection", exact: true }).waitFor();
            for (const name of ["Edit", "Delete"]) {
              const action = page.getByRole("button", { name, exact: true });
              await action.waitFor();
              expect(await action.isDisabled()).toBe(true);
            }
          });
          await step("Member sees tool policies without a way to change them", async () => {
            // Policies on the Tools page are workspace rules the server refuses
            // for members, so the row menus and the detail badge menu stay off.
            await visit(page, "/tools");
            await page.getByRole("button").filter({ hasText: "executor" }).first().waitFor();
            expect(
              await page.getByRole("button", { name: /^Set policy/ }).count(),
              "members get no policy menus on tool rows",
            ).toBe(0);
            await visit(page, `/integrations/${slug}`);
            await page.getByRole("button", { name: "Add connection", exact: true }).waitFor();
          });
          await step("Member can still add a personal connection", async () => {
            await page.getByRole("button", { name: "Add connection", exact: true }).click();
            const dialog = page.getByRole("dialog");
            await dialog.waitFor();
            expect(await dialog.getByText("Workspace", { exact: true }).count()).toBe(0);
          });
          await step("Member browses the catalog with disabled Add buttons", async () => {
            await visit(page, "/integrations/browse");
            await page.getByRole("heading", { name: "Add an integration", exact: true }).waitFor();
            await page
              .getByText("Requires a workspace admin to add integrations.", { exact: true })
              .waitFor();
            const addButtons = page.getByRole("button", { name: /^Add / });
            await addButtons.first().waitFor();
            for (const button of await addButtons.all())
              expect(await button.isDisabled()).toBe(true);
            const scratch = page.getByRole("button", {
              name: "New OpenAPI integration from scratch",
              exact: true,
            });
            expect(await scratch.isDisabled()).toBe(true);
            const view = page.getByRole("link", { name: `View ${title}`, exact: true });
            await view.waitFor();
            expect(await view.isEnabled()).toBe(true);
          });
          await step("Member cannot add a URL with the button or Enter key", async () => {
            const input = page.getByRole("textbox", {
              name: "Search integrations, or paste a URL",
            });
            await input.fill("https://api.example.com/openapi.json");
            expect(
              await page.getByRole("button", { name: "Add this URL", exact: true }).isDisabled(),
            ).toBe(true);
            const before = page.url();
            await input.press("Enter");
            expect(page.url()).toBe(before);
          });
          for (const path of ["/integrations/add/openapi", "/integrations/add/mcp"]) {
            await step(`Member follows ${path} and sees the admin explanation`, async () => {
              await visit(page, path);
              await page.getByRole("heading", { name: "An admin must add integrations" }).waitFor();
              expect(await page.getByRole("textbox").count()).toBe(0);
              expect(await page.getByRole("button", { name: /^Add/ }).count()).toBe(0);
            });
          }
          await step("Member returns to their existing integrations", async () => {
            await page.getByRole("link", { name: "Back to integrations" }).click();
            await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor();
          });
        });
      }),
      adminClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
    );
  });
