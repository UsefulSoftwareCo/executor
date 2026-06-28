import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([toolkitsPlugin(), openApiHttpPlugin()] as const);

const hiddenPersonalSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Personal Hidden API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/personal-only": {
        get: {
          operationId: "personalOnly",
          responses: { "200": { description: "Personal-only response" } },
        },
      },
    },
  });

scenario(
  "Toolkits · self-host UI creates a toolkit and configures tools",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const suffix = randomBytes(4).toString("hex");
    const prefix = `toolkits-ui-${suffix}`;
    const name = `${prefix}-created`;
    const slug = name;
    const hiddenPersonalIntegration = `${prefix}-personal-api`;
    const hiddenPersonalConnection = "mine";
    const seededToolkits = [
      { owner: "org" as const, name: `${prefix}-workspace-a` },
      { owner: "org" as const, name: `${prefix}-workspace-b` },
      { owner: "user" as const, name: `${prefix}-personal-a` },
      { owner: "user" as const, name: `${prefix}-personal-b` },
      { owner: "user" as const, name: `${prefix}-personal-c` },
    ];
    let addedConnectionPattern = "";
    const blockPattern = "executor.coreTools.policies.list";

    const cleanup = Effect.gen(function* () {
      yield* client.connections
        .remove({
          params: {
            owner: "user",
            integration: IntegrationSlug.make(hiddenPersonalIntegration),
            name: ConnectionName.make(hiddenPersonalConnection),
          },
        })
        .pipe(Effect.ignore);
      yield* client.openapi
        .removeSpec({ params: { slug: hiddenPersonalIntegration } })
        .pipe(Effect.ignore);
      const listed = yield* client.toolkits.list();
      yield* Effect.forEach(
        listed.toolkits.filter((row) => row.slug.startsWith(prefix)),
        (toolkit) => client.toolkits.remove({ params: { toolkitId: toolkit.id } }),
        { discard: true },
      );
    }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* Effect.forEach(
        seededToolkits,
        (toolkit) => client.toolkits.create({ payload: toolkit }),
        { discard: true },
      );
      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: hiddenPersonalSpec("http://127.0.0.1:59999") },
          slug: IntegrationSlug.make(hiddenPersonalIntegration),
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { "x-api-key": [{ type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "user",
          name: ConnectionName.make(hiddenPersonalConnection),
          integration: IntegrationSlug.make(hiddenPersonalIntegration),
          template: AuthTemplateSlug.make("apiKey"),
          value: "unused-token",
        },
      });

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Toolkits plugin page", async () => {
          await page.goto("/default/toolkits/", { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "Toolkits" }).waitFor();
          await page.getByRole("heading", { name: "Workspace" }).waitFor();
          await page.getByRole("heading", { name: "Personal" }).waitFor();
          await page.getByRole("button", { name: "Add workspace toolkit" }).waitFor();
          await page.getByRole("button", { name: "Add personal toolkit" }).waitFor();
          await page.locator('main [data-slot="skeleton"]').first().waitFor({ state: "detached" });
          expect(await page.locator('main [data-slot="skeleton"]').count()).toBe(0);
          const seededCard = page.getByRole("link", {
            name: `Open toolkit ${prefix}-workspace-a`,
          });
          await seededCard.waitFor();
          expect(await seededCard.getByText("/mcp/toolkits").count()).toBe(0);
          expect(await seededCard.getByText("Workspace tools").count()).toBe(0);
          expect(await page.getByLabel("New toolkit").count()).toBe(0);
        });

        await step("Create a workspace toolkit from the add card", async () => {
          const workspaceSection = page.locator("section").filter({
            has: page.getByRole("heading", { name: "Workspace" }),
          });
          await workspaceSection.getByRole("button", { name: "Add workspace toolkit" }).click();
          await page.getByRole("dialog", { name: "New workspace toolkit" }).waitFor();
          await page.getByLabel("Toolkit name").fill(name);
          await page.getByRole("button", { name: "Create toolkit" }).click();
          await page.getByRole("link", { name: `Open toolkit ${name}` }).waitFor();
        });

        await step("Validate owner sections render as three-column grids", async () => {
          const workspaceSection = page.locator("section").filter({
            has: page.getByRole("heading", { name: "Workspace" }),
          });
          const personalSection = page.locator("section").filter({
            has: page.getByRole("heading", { name: "Personal" }),
          });

          const workspaceColumns = await workspaceSection
            .getByRole("link", { name: /^Open toolkit/ })
            .evaluateAll((nodes) =>
              nodes.slice(0, 3).map((node) => Math.round(node.getBoundingClientRect().left)),
            );
          const personalColumns = await personalSection
            .getByRole("link", { name: /^Open toolkit/ })
            .evaluateAll((nodes) =>
              nodes.slice(0, 3).map((node) => Math.round(node.getBoundingClientRect().left)),
            );

          expect(new Set(workspaceColumns).size).toBe(3);
          expect(new Set(personalColumns).size).toBe(3);
        });

        await step("Open the created toolkit from the grid", async () => {
          await page.getByRole("link", { name: `Open toolkit ${name}` }).click();
          await page.waitForURL(new RegExp(`/toolkits/${slug}$`));
          expect(page.url()).toMatch(new RegExp(`/toolkits/${slug}$`));
          await page
            .locator("code")
            .filter({ hasText: `/mcp/toolkits/${slug}` })
            .waitFor();
          await page.getByText("No connections added").waitFor();
          expect(await page.getByLabel("New toolkit").count()).toBe(0);
        });

        await step("Return to the toolkit grid with browser-visible routing", async () => {
          await page.getByRole("button", { name: "Toolkits" }).click();
          await page.waitForURL(/\/toolkits\/?$/);
          expect(page.url()).toMatch(/\/toolkits\/?$/);
          await page.getByRole("heading", { name: "Workspace" }).waitFor();
          await page.getByRole("link", { name: `Open toolkit ${name}` }).waitFor();
        });

        await step("Open the created toolkit from a direct URL", async () => {
          await page.goto(`/default/toolkits/${slug}`, { waitUntil: "domcontentloaded" });
          expect(page.url()).toMatch(new RegExp(`/toolkits/${slug}$`));
          await page
            .locator("code")
            .filter({ hasText: `/mcp/toolkits/${slug}` })
            .waitFor();
          await page.getByText("No connections added").waitFor();
          expect(await page.getByLabel("New toolkit").count()).toBe(0);
        });

        await step("Cancel toolkit deletion from the confirmation modal", async () => {
          await page.getByRole("button", { name: "Delete toolkit" }).click();
          const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
          await dialog.waitFor();
          await dialog.getByRole("button", { name: "Cancel" }).click();
          await dialog.waitFor({ state: "detached" });
          await page.getByRole("heading", { name }).waitFor();
        });

        await step("The connection picker explains hidden personal connections", async () => {
          await page.getByRole("button", { name: "Manage toolkit connections" }).click();
          const dialog = page.getByRole("dialog", { name: "Manage connections" });
          await dialog.waitFor();
          await dialog
            .getByText(
              "You have 1 personal connection that is not shown because this is a shared toolkit.",
            )
            .waitFor();
        });

        await step("Add a connection to the toolkit", async () => {
          const dialog = page.getByRole("dialog", { name: "Manage connections" });
          await dialog.waitFor();
          await dialog.getByLabel("Search connections and tools").fill("policies.list");
          expect(await dialog.getByRole("button", { name: /^Add tool/ }).count()).toBe(0);
          addedConnectionPattern = "executor.*";
          expect(await dialog.getByText(addedConnectionPattern, { exact: true }).count()).toBe(0);
          await dialog
            .getByRole("button", { name: /^Add connection / })
            .first()
            .click();
          await dialog.getByRole("button", { name: /^Remove connection / }).waitFor();
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          const toolkitTools = page.getByRole("region", { name: "Toolkit tools" });
          await toolkitTools.waitFor();
          await toolkitTools.getByLabel("Filter tools").fill("policies.list");
          await toolkitTools.getByRole("button").filter({ hasText: "list" }).last().waitFor();
          await toolkitTools.getByLabel("Filter tools").clear();
        });

        await step("The add connection list reflects the saved toolkit connection", async () => {
          await page.getByRole("button", { name: "Manage toolkit connections" }).click();
          const dialog = page.getByRole("dialog", { name: "Manage connections" });
          await dialog.waitFor();
          await dialog.getByLabel("Search connections and tools").fill("policies.list");
          await dialog.getByRole("button", { name: /^Remove connection / }).waitFor();
          expect(await dialog.getByRole("button", { name: /^Add connection / }).count()).toBe(0);
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
        });

        await step("Remove the connection from the manage modal", async () => {
          await page.getByRole("button", { name: "Manage toolkit connections" }).click();
          const removeDialog = page.getByRole("dialog", { name: "Manage connections" });
          await removeDialog.waitFor();
          await removeDialog.getByLabel("Search connections and tools").fill("policies.list");
          await removeDialog
            .getByRole("button", { name: /^Remove connection / })
            .first()
            .click();
          await removeDialog.getByRole("button", { name: /^Add connection / }).waitFor();
          await page.keyboard.press("Escape");
          await removeDialog.waitFor({ state: "hidden" });
          await page.getByText("No connections added").waitFor();
          await page.getByRole("button", { name: "Manage toolkit connections" }).click();
          const dialog = page.getByRole("dialog", { name: "Manage connections" });
          await dialog.waitFor();
          await dialog.getByLabel("Search connections and tools").fill("policies.list");
          await dialog
            .getByRole("button", { name: /^Add connection / })
            .first()
            .click();
          await dialog.getByRole("button", { name: /^Remove connection / }).waitFor();
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          const toolkitTools = page.getByRole("region", { name: "Toolkit tools" });
          await toolkitTools.getByLabel("Filter tools").fill("policies.list");
          await toolkitTools.getByRole("button").filter({ hasText: "list" }).last().waitFor();
          await toolkitTools.getByLabel("Filter tools").clear();
        });

        await step("Block one tool from the toolkit tools list", async () => {
          const toolkitTools = page.getByRole("region", { name: "Toolkit tools" });
          await toolkitTools.getByLabel("Filter tools").fill("policies.list");
          await toolkitTools.getByRole("button").filter({ hasText: "list" }).last().click();
          await page.getByRole("button", { name: "Set policy", exact: true }).click();
          await page.getByText(blockPattern, { exact: true }).waitFor();
          await page.getByRole("menuitem", { name: "Block" }).click();
          await toolkitTools.getByRole("button").filter({ hasText: "list" }).last().waitFor();
          await page.getByText("This tool is not available through the current toolkit.").waitFor();
        });
      });

      const listed = yield* client.toolkits.list();
      const toolkit = listed.toolkits.find((row) => row.slug === slug);
      expect(toolkit, "the UI-created toolkit persisted").toBeDefined();
      if (!toolkit) return;
      expect(toolkit.owner).toBe("org");

      const { policies } = yield* client.toolkits.listPolicies({
        params: { toolkitId: toolkit.id },
      });
      const { connections } = yield* client.toolkits.listConnections({
        params: { toolkitId: toolkit.id },
      });
      expect(addedConnectionPattern.length, "the UI selected a connection").toBeGreaterThan(0);
      expect(
        connections.map((connection) => connection.pattern),
        "the UI-authored toolkit connection persisted",
      ).toContain(addedConnectionPattern);
      expect(
        policies.map((policy) => `${policy.pattern} ${policy.action}`).sort(),
        "the UI-authored toolkit access persisted with its action",
      ).toEqual([`${blockPattern} block`]);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
