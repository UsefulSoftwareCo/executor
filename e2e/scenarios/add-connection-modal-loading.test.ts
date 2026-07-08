// Cross-target (browser): a cold deep link into the add-connection modal must
// show a loading shell while the integration catalog is still resolving, not a
// half-initialized credential form. The cloud harness follows the same public
// UI path as selfhost for this open-MCP setup.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Connections · the add modal holds a loading shell until auth methods resolve",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({
          name: `loading-shell-mcp-${randomBytes(3).toString("hex")}`,
        }),
      );
      const identity = yield* target.newIdentity();
      let integrationPath = "";

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Create an MCP integration with a declared API key method", async () => {
          await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`, {
            waitUntil: "networkidle",
          });
          await page.getByText("How does this server authenticate?").waitFor({ timeout: 90_000 });
          await page.getByRole("button", { name: "Add method" }).click();
          await page.getByText("Method 2").waitFor();
          await page.getByRole("button", { name: "Add integration" }).click();
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          integrationPath = new URL(page.url()).pathname;
          await page.getByText("Connections").first().waitFor();
        });
      });

      yield* browser.session(identity, async ({ page, step }) => {
        let releaseIntegrations!: () => void;
        const integrationsHeld = new Promise<void>((resolve) => {
          releaseIntegrations = resolve;
        });
        let holdNextCatalogRequest = true;
        let holdNextMcpServerRequest = true;
        await page.route("**/api/integrations**", async (route) => {
          if (!holdNextCatalogRequest) {
            await route.continue();
            return;
          }
          holdNextCatalogRequest = false;
          const response = await route.fetch();
          await integrationsHeld;
          await route.fulfill({ response });
        });
        await page.route("**/api/mcp/servers/**", async (route) => {
          if (!holdNextMcpServerRequest) {
            await route.continue();
            return;
          }
          holdNextMcpServerRequest = false;
          const response = await route.fetch();
          await integrationsHeld;
          await route.fulfill({ response });
        });

        await step(
          "Open the deep link while the integration catalog response is held",
          async () => {
            await page.goto(`${integrationPath}?addAccount=1`, { waitUntil: "commit" });
            await page.getByRole("dialog", { name: /Add connection/ }).waitFor();
            await page.getByTestId("add-account-loading-shell").waitFor();
          },
        );

        await step("The held modal has no half-initialized credential form", async () => {
          const dialog = page.getByRole("dialog", { name: /Add connection/ });
          expect(
            await dialog.getByRole("tab").count(),
            "auth method tabs are not rendered until methods resolve",
          ).toBe(0);
          const enabledContinueButtons = await dialog
            .getByRole("button", { name: "Continue" })
            .evaluateAll(
              (buttons) =>
                buttons.filter(
                  (button) =>
                    button instanceof HTMLButtonElement &&
                    !button.disabled &&
                    button.offsetParent !== null,
                ).length,
            );
          expect(
            enabledContinueButtons,
            "the loading shell must not expose an enabled Continue button",
          ).toBe(0);
          expect(
            await page.getByTestId("add-account-loading-shell").isVisible(),
            "the loading shell is visible while the catalog is held",
          ).toBe(true);
        });

        await step("The resolved modal mounts with the declared method tabs", async () => {
          const dialog = page.getByRole("dialog", { name: /Add connection/ });
          releaseIntegrations();
          await page.getByTestId("add-account-loading-shell").waitFor({ state: "detached" });
          await dialog.getByRole("tab", { name: "No authentication" }).waitFor();
          await dialog.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
        });
      });
    }),
  ),
);
