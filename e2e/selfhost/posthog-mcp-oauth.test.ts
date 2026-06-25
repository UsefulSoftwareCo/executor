// Selfhost browser regression for the reported PostHog MCP OAuth dead-end. A
// real Executor instance adds https://mcp.posthog.com/mcp, then starts the
// connection flow. The product guarantee: clicking Connect opens PostHog's
// OAuth authorization page through dynamic client registration, not the
// bring-your-own OAuth app picker with "Automatic setup unavailable".
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const POSTHOG_MCP_URL = "https://mcp.posthog.com/mcp";
const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "MCP OAuth · PostHog starts OAuth from Add connection",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const displayName = `PostHog MCP ${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name: displayName }));

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at PostHog", async () => {
            const addUrl = new URL("/integrations/add/mcp", target.baseUrl);
            addUrl.searchParams.set("url", POSTHOG_MCP_URL);
            await page.goto(addUrl.toString(), { waitUntil: "networkidle" });
            await page.getByText("How does this server authenticate?").waitFor({ timeout: 30_000 });
            await page.getByText("Method 1 · Detected").waitFor();
            await page.getByText("OAuth metadata is discovered from this server").waitFor();
          });

          await step("Add the PostHog MCP source", async () => {
            await page.getByPlaceholder("e.g. Linear").fill(displayName);
            await page.getByRole("button", { name: "Add source" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            const landedSlug = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
            expect(landedSlug, "the add flow lands on the created integration").toBe(String(slug));
            await page.getByText("Connections").first().waitFor();
          });

          await step("Start OAuth from Add connection", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            await page.getByRole("tab", { name: "OAuth" }).waitFor();

            const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
            await page.getByRole("button", { name: "Connect", exact: true }).click();
            const popup = await popupPromise;
            await popup.waitForURL(/^https:\/\/oauth\.posthog\.com\/oauth\/authorize\//, {
              timeout: 30_000,
            });
            await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 });

            const authorizeUrl = new URL(popup.url());
            expect(authorizeUrl.origin, "OAuth opened PostHog's authorization host").toBe(
              "https://oauth.posthog.com",
            );
            expect(authorizeUrl.pathname, "OAuth opened the authorize endpoint").toBe(
              "/oauth/authorize/",
            );
            expect(
              authorizeUrl.searchParams.get("resource"),
              "resource targets the MCP endpoint",
            ).toBe(POSTHOG_MCP_URL);
            await popup.close();
          });
        });
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore)));
    }),
  ),
);
