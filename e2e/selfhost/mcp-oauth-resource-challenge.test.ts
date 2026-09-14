import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "MCP OAuth · the endpoint challenge selects the resource used by browser authorization",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const baseUrl = yield* createEmulatorInstance("mcp", "resource-challenge");
      const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl, service: "mcp" }));
      const slug = IntegrationSlug.make(`resource_challenge_${randomBytes(4).toString("hex")}`);

      // The published emulator advertises root metadata in its Bearer challenge,
      // while its path-scoped document describes a different resource (/mcp).
      const probe = yield* client.oauth.probe({ payload: { url: `${baseUrl}/mcp` } });
      expect(probe.resource).toBe(baseUrl);

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Resource challenge MCP",
          endpoint: `${baseUrl}/mcp`,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
      );
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the protected integration", async () => {
          await visit(page, `/integrations/${slug}`);
          await page.getByRole("button", { name: "Add connection" }).waitFor();
        });
        await step("Connect using the resource advertised by the server", async () => {
          await page.getByRole("button", { name: "Add connection" }).click();
          const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
          await page.getByRole("button", { name: "Connect", exact: true }).click();
          const popup = await popupPromise;
          await popup.waitForURL((url) => url.pathname.endsWith("/authorize"), { timeout: 60_000 });
          expect(new URL(popup.url()).searchParams.get("resource")).toBe(baseUrl);
          // The hosted emulator's button omits its required login field.
          // Authorize the synthetic account through its HTTP form contract.
          const authorization = new URL(popup.url());
          const approved = await popup.request.post(`${baseUrl}/authorize/approve`, {
            form: { ...Object.fromEntries(authorization.searchParams), login: "admin" },
            maxRedirects: 0,
          });
          expect(approved.status()).toBe(302);
          const callback = approved.headers()["location"];
          if (!callback) throw new Error("The emulator did not return an OAuth callback");
          await popup.goto(callback);
          await popup.getByRole("heading", { name: "Connected" }).waitFor({ timeout: 30_000 });
        });
      });
      const clients = yield* client.oauth.listClients();
      expect(clients.some((app) => app.resource === baseUrl)).toBe(true);
      const ledger = yield* Effect.promise(() => emulator.ledger.list());
      expect(ledger.some((entry) => entry.path === "/token" && entry.response.status === 200)).toBe(
        true,
      );
    }),
  ),
);
