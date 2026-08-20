// Selfhost browser coverage for the transparent DCR connect when OAuth
// discovery is slow, the shape behind the report: "When I hit connect, it loads
// for a second, but then theres no user feedback and nothing happens."
//
// One click runs probe -> register -> start. The first two are network round
// trips, and `window.open` needs transient user activation, which a real
// browser expires a few seconds after the click. The shipped code opened the
// sign-in window AFTER both round trips, so once the API was slow the browser
// refused it and the connect died silently. The window is now claimed on the
// click and navigated later, so discovery latency no longer decides whether the
// user can connect.
//
// What this scenario guards: the whole slow path still works end to end, with
// the reservation threaded from the click through registration to a window that
// really lands on the discovered authorization server.
//
// What it CANNOT guard, and why: Playwright drives Chromium in automation mode,
// which never enforces the activation rule for `window.open` (verified headed
// and headless, and with `--disable-popup-blocking` removed via
// ignoreDefaultArgs). So a browser here opens the window no matter how stale
// the click is, and this scenario passes against the pre-fix ordering too. The
// ordering itself is pinned by unit tests over `runDcrConnect` in
// packages/react/src/components/add-account-modal.test.ts, which do fail when
// the reservation moves back after the round trips. See LEARNINGS.md.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServerWithOAuth } from "@executor-js/plugin-mcp/testing";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { OAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

// Comfortably past Chromium's ~5s transient user activation once both land on
// the same click, and well under the step timeouts below.
const STALL_MS = 3_500;

const isDiscoveryCall = (url: string): boolean =>
  url.includes("/api/oauth/probe") || url.includes("/api/oauth/clients/register-dynamic");

scenario(
  "MCP OAuth · a slow discovery round trip still opens the sign-in window",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: "slow-connect-mcp" }),
        { path: "/mcp" },
      );
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const displayName = `Slow MCP ${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name: displayName }));

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Add an OAuth-protected MCP integration", async () => {
            const addUrl = new URL("/integrations/add/mcp", target.baseUrl);
            addUrl.searchParams.set("url", server.endpoint);
            await page.goto(addUrl.toString(), { waitUntil: "networkidle" });
            await page.getByText("How does this server authenticate?").waitFor({ timeout: 30_000 });
            await page.getByPlaceholder("e.g. Linear").fill(displayName);
            await page.getByRole("button", { name: "Add integration" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            await page.getByText("Connections").first().waitFor();
          });

          await step("Make OAuth discovery slow, the way a degraded API is", async () => {
            // Delay the responses rather than the requests, so the app sees a
            // genuinely slow API and not a stalled network stack.
            await page.route(
              (url) => isDiscoveryCall(url.href),
              async (route) => {
                await new Promise((resolve) => setTimeout(resolve, STALL_MS));
                await route.continue();
              },
            );
          });

          await step("Connect, and wait out the slow discovery", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            await page.getByRole("tab", { name: "OAuth" }).waitFor();

            const popupPromise = page.waitForEvent("popup", { timeout: 60_000 });
            await page.getByRole("button", { name: "Connect", exact: true }).click();

            // In a real browser the two stalls outlast the click's user
            // activation, so this popup only exists because it was reserved on
            // the click. Automation-mode Chromium would open it either way;
            // the ordering is pinned by the unit tests named above.
            const popup = await popupPromise;
            await popup.waitForURL((url) => url.origin === new URL(oauth.issuerUrl).origin, {
              timeout: 60_000,
            });
            await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 });
            expect(
              new URL(popup.url()).origin,
              "the reserved window reached the discovered authorization host",
            ).toBe(new URL(oauth.authorizationEndpoint).origin);
            await popup.close();
          });
        });

        const oauthRequests = yield* oauth.requests;
        expect(
          oauthRequests.some(
            (request) => request.method === "POST" && request.path === "/register",
          ),
          "the slow connect still dynamically registered its OAuth client",
        ).toBe(true);
        expect(
          oauthRequests.some(
            (request) => request.method === "GET" && request.path === "/authorize",
          ),
          "the slow connect still reached the authorize endpoint",
        ).toBe(true);
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore)));
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer())),
);
