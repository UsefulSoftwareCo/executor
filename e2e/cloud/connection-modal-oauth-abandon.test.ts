// Cloud (browser): abandoning an OAuth connection must not wedge the
// add-connection modal. A user picks a registered OAuth app, clicks "Connect
// with OAuth" (the modal opens the provider popup and flips to a busy
// "Connecting…" state), then bails by closing the popup without granting consent.
// The popup-closed signal is intentionally not polled (providers' COOP headers
// make `popup.closed` unreliable), so the modal can't detect the abandonment on
// its own. The guarantee under test: closing the modal afterwards RESETS it, so
// reopening offers a fresh attempt instead of staying stuck on "Connecting…".
//
// Repro for the user report: "I bailed on finishing the OAuth connection … the
// Executor app can't detect [it]. But closing the modal should reset the state
// so I can try again."
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

scenario(
  "Connections · closing the add-connection modal after abandoning OAuth lets you try again (not stuck on Connecting)",
  { timeout: 120_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      // A real authorization server on 127.0.0.1: the modal's popup navigates to
      // its authorize page, which we abandon by closing the window.
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      // An integration that declares an OAuth auth method (no DCR: it carries
      // explicit endpoints, no registration/discovery URL), so the modal shows
      // the bring-your-own app picker.
      const integration = IntegrationSlug.make(unique("oauthint"));
      yield* client.openapi.addSpec({
        payload: {
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "OAuth-protected API", version: "1.0.0" },
              paths: {
                "/me": {
                  get: {
                    operationId: "getMe",
                    tags: ["default"],
                    responses: { "200": { description: "the caller" } },
                  },
                },
              },
            }),
          },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: "oauth",
              kind: "oauth2",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
            },
          ],
        },
      });

      // A registered OAuth app whose endpoints match the integration's, so the
      // picker auto-selects it and the footer offers "Connect with OAuth".
      const clientSlug = OAuthClientSlug.make(unique("oauthc"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
      });

      yield* browser.session(identity, async ({ page, step }) => {
        const dialog = page.getByRole("dialog");
        const addConnection = page.getByRole("button", { name: "Add connection", exact: true });
        const connectWithOAuth = dialog.getByRole("button", { name: "Connect with OAuth" });
        const connecting = dialog.getByRole("button", { name: "Connecting…" });

        await step("Open the integration and start a new connection", async () => {
          await page.goto(`/integrations/${integration}`, { waitUntil: "networkidle" });
          await addConnection.click();
          // The registered app is auto-selected, so the OAuth connect button is
          // present and enabled.
          await connectWithOAuth.waitFor({ state: "visible", timeout: 15_000 });
          expect(
            await connectWithOAuth.isDisabled(),
            "the auto-selected app makes Connect with OAuth actionable",
          ).toBe(false);
        });

        await step("Begin OAuth, then bail by closing the provider popup", async () => {
          const [popup] = await Promise.all([page.waitForEvent("popup"), connectWithOAuth.click()]);
          // The footer flips to the busy "Connecting…" state while the popup is
          // open; the flow is genuinely in flight.
          await connecting.waitFor({ state: "visible", timeout: 15_000 });
          // Let the popup actually reach the authorize page so the OAuth session
          // is live, then abandon it: the user closes the window without
          // granting consent.
          await popup.waitForURL((url) => !url.href.startsWith("about:"), { timeout: 15_000 });
          await popup.close();
        });

        await step("Close the modal", async () => {
          // The Close button is disabled while busy, so the user backs out with
          // Escape, exactly the "bail" path from the report.
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden", timeout: 15_000 });
        });

        await step(
          "Reopen the modal: it offers a fresh attempt, not a stuck Connecting",
          async () => {
            await addConnection.click();
            await dialog.waitFor({ state: "visible", timeout: 15_000 });
            await page.waitForLoadState("networkidle");

            // The guarantee: the reopened modal is reset. Before the fix it stays
            // wedged on "Connecting…" (the abandoned flow's busy state survived the
            // close), so this count is 1 and the test fails, reproducing the bug.
            expect(
              await connecting.count(),
              "the reopened modal must not be stuck in the Connecting state",
            ).toBe(0);

            // And a fresh OAuth attempt is actually offered and actionable again.
            await connectWithOAuth.waitFor({ state: "visible", timeout: 15_000 });
            expect(
              await connectWithOAuth.isDisabled(),
              "the reopened modal lets the user start OAuth again",
            ).toBe(false);
          },
        );
      });
    }),
  ),
);
