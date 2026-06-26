// Selfhost (browser): REPRO for issue #1120 ("Can't configure oauth mcp which
// used to work"). The user added an Atlassian remote-MCP source and the OAuth
// app picker listed a pile of unrelated *Datadog* apps.
//
// Why it happens: a remote MCP OAuth method carries ONLY a `discoveryUrl`
// (endpoints are discovered live, see describeMcpAuthMethods in the mcp plugin),
// never a static token/authorization URL. When transparent DCR falls back to the
// bring-your-own app picker, the picker filters candidate apps by endpoint root
// domain (`selectClientsForEndpoints`). With no declared endpoints the filter
// short-circuits to "every app is usable", so EVERY registered OAuth client the
// owner has, including DCR-minted apps from other integrations, leaks into this
// integration's picker. The `origin.integration` slug each client carries is
// never consulted.
//
// The fix: the picker matches apps to the integration by `origin.integration`
// (recorded on every app, DCR or manual), falling back to endpoint-domain
// matching only when endpoints are declared. So an app registered FOR Atlassian
// shows, and a Datadog app (different integration, no shared endpoint) does not.
//
// This scenario registers two apps for the same owner — one Datadog app with NO
// integration association, and one app registered FOR the Atlassian MCP source —
// then drives that source into the BYO picker (its discovery endpoint advertises
// no OAuth metadata, so DCR falls back) and asserts the Atlassian app appears
// while the Datadog app does not.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "OAuth picker · a different integration's app does not leak into an MCP source's picker",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Selfhost shares one tenant across identities, so make every resource
      // unique per run — including the Datadog host, which is what the picker
      // row renders and what we assert against.
      const id = randomBytes(4).toString("hex");
      const datadogSlug = OAuthClientSlug.make(`datadog-${id}`);
      const datadogHost = `api-${id}.datadoghq.com`;
      const atlassianSlug = OAuthClientSlug.make(`atlassian-app-${id}`);
      const atlassianHost = `auth-${id}.atlassian.com`;
      const mcpSlug = IntegrationSlug.make(`atlassian-mcp-${id}`);

      // An Atlassian-shaped remote MCP source: it speaks MCP but advertises NO
      // OAuth metadata, so the connect-time DCR probe finds no registration
      // endpoint and the modal falls back to the bring-your-own app picker.
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({ name: `atlassian-mcp-${id}` }),
      );

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // A Datadog OAuth app the owner registered for a DIFFERENT integration.
          // Endpoints are on datadoghq.com — nothing to do with Atlassian, and no
          // integration association — so it must never surface in this picker.
          yield* client.oauth.createClient({
            payload: {
              owner: "user",
              slug: datadogSlug,
              authorizationUrl: `https://${datadogHost}/oauth2/authorize`,
              tokenUrl: `https://${datadogHost}/oauth2/token`,
              grant: "authorization_code",
              clientId: `datadog-client-${id}`,
              clientSecret: "datadog-secret",
            },
          });

          // An app the owner registered FOR the Atlassian MCP source. It carries
          // `origin.integration`, so the picker surfaces it even though the source
          // declares no static endpoints to match on.
          yield* client.oauth.createClient({
            payload: {
              owner: "user",
              slug: atlassianSlug,
              authorizationUrl: `https://${atlassianHost}/authorize`,
              tokenUrl: `https://${atlassianHost}/token`,
              grant: "authorization_code",
              clientId: `atlassian-client-${id}`,
              clientSecret: "atlassian-secret",
              originIntegration: mcpSlug,
            },
          });

          // Persistence guard: the integration association round-trips through the
          // API so the picker can rely on it (isolates server-side persistence
          // from the browser read path).
          const listed = yield* client.oauth.listClients();
          const atlassianRow = listed.find((c) => String(c.slug) === String(atlassianSlug));
          expect(
            atlassianRow?.origin.integration && String(atlassianRow.origin.integration),
            "the manually-registered app records its integration association",
          ).toBe(String(mcpSlug));

          // The Atlassian MCP source as the add flow would leave it: OAuth only.
          yield* client.mcp.addServer({
            payload: {
              transport: "remote",
              name: `Atlassian MCP ${id}`,
              endpoint: server.endpoint,
              slug: mcpSlug,
              authenticationTemplate: [{ kind: "oauth2" }],
            },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the Atlassian MCP source's connect modal", async () => {
              await page.goto(`/integrations/${mcpSlug}`, { waitUntil: "networkidle" });
              await page.getByRole("button", { name: "Add connection" }).first().click();
              // OAuth is the only method; transparent DCR shows the Connect CTA.
              await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
            });

            await step("DCR falls back to the bring-your-own app picker", async () => {
              await page.getByRole("button", { name: "Connect", exact: true }).click();
              // The probe finds no OAuth metadata and DCR falls back to the app
              // step. Either register affordance ("Register a new app" when an app
              // matched, "Register app" in the empty state) means we're past DCR.
              await page
                .getByRole("button", { name: /^Register (app|a new app)$/ })
                .first()
                .waitFor({ timeout: 30_000 });
            });

            await step("The picker lists the Atlassian app, not the Datadog one", async () => {
              const dialog = page.getByRole("dialog");
              expect(
                await dialog.getByText(atlassianHost).count(),
                `the app registered for this integration (${atlassianHost}) is offered`,
              ).toBeGreaterThan(0);
              expect(
                await dialog.getByText(datadogHost).count(),
                `a Datadog OAuth app (${datadogHost}) must not leak into Atlassian's picker`,
              ).toBe(0);
            });
          });
        }),
        // Never leak the source or the apps into the shared selfhost tenant.
        Effect.gen(function* () {
          yield* client.mcp.removeServer({ params: { slug: mcpSlug } }).pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: datadogSlug }, payload: { owner: "user" } })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: atlassianSlug }, payload: { owner: "user" } })
            .pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
