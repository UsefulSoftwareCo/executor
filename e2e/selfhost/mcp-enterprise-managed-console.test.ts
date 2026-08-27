// Selfhost (browser, recorded): MCP Enterprise-Managed Authorization, END TO
// END THROUGH THE CONSOLE. Every step below happens in a real browser — there is
// no typed-API shortcut anywhere in the journey, which is the point: the two
// parent branches each proved half of this profile against the API, and the leg
// neither could reach was the one a customer actually walks.
//
// The journey, in the order a workspace meets it:
//
//   1. An administrator registers the organization's identity provider by
//      ISSUER — the console probes it and records the endpoints, so nobody
//      transcribes an authorize path whose only symptom would be every member's
//      connect failing later at the wrong host.
//   2. They mark an ordinary MCP server "Managed by your organization", and the
//      declaration survives the replace-mode save that rewrites the whole
//      auth-method list.
//   3. They register the server's enterprise (`id_jag`) app from the connect
//      modal, which is where the console TELLS them it is missing rather than
//      quietly registering an interactive client and asking for consent.
//   4. A member clicks connect. Executor asks for a work identity, the sign-in
//      window lands on the identity provider's real login page, and after the
//      link the connection is minted with NO consent screen — proven by absence
//      in the MCP server's own ledger.
//   5. A tool call rides the result.
//   6. An administrator denies the client at the identity provider, and a fresh
//      connect shows the blocked-by-administrator state IN THE BROWSER, with no
//      interactive fallback offered.
//
// Two emulators stand in for the pilot's real parties: `okta` is the customer's
// identity provider (real OIDC discovery, a real sign-in page, RFC 8693
// exchanges, and an administrator policy table), `mcp` is the third-party server
// and its Resource Authorization Server.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

const OKTA_USER = "testuser@okta.local";
const OKTA_AUTH_SERVER = "default";

// The reserved (owner, slug) the console registers the organization's identity
// provider under. Fixed by the product, not by this scenario — a managed server
// names exactly this app, with no slug typed anywhere.
const IDP_CLIENT = OAuthClientSlug.make("enterprise-identity-provider");

const MANAGED_BADGE = "Managed by your organization";

const freshSlug = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

const availablePort = Effect.callback<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

/** A locally spawned emulator on an OS-assigned port, closed with the scope.
 *  Local rather than hosted: this scenario depends on behavior that shipped in
 *  `@executor-js/emulate` 0.14.0 (Okta minting ID-JAGs), and the npm package is
 *  the version this checkout pins. */
const emulator = (service: "okta" | "mcp") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const port = yield* availablePort;
      return yield* Effect.promise(() => createEmulator({ service, port }));
    }),
    (instance: Emulator) => Effect.promise(() => instance.close()).pipe(Effect.ignore),
  );

const requireString = (value: string | undefined | null, what: string): string => {
  if (!value) throw new Error(`emulator returned no ${what}`);
  return value;
};

const connectionsSection = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { level: 3, name: "Connections" }),
  });

const callGetMeCode = (slug: string, owner: string, connection: string) => `
const result = await tools.${slug}.${owner}.${connection}.get_me({});
return { ok: result.ok, payload: result.ok ? result.data : result.error };
`;

/** Open the add-connection modal on an integration page. */
const openConnectModal = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Add connection" }).first().click();
  await page.getByRole("heading", { name: /Add connection/ }).waitFor({ timeout: 30_000 });
};

scenario(
  "MCP enterprise-managed authorization (console) · an administrator sets a server up and a member connects with their work identity, entirely in the browser",
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const okta = yield* emulator("okta");
      const mcp = yield* emulator("mcp");
      const mcpEndpoint = `${mcp.url}/mcp`;
      // The link comes back to executor's OWN OAuth callback — the same one
      // every interactive connect uses, so an enterprise allow-lists one
      // redirect URI and not two. The emulator matches it exactly, so this
      // scenario fails loudly if the console ever asks for a different one.
      const executorCallback = new URL("/api/oauth/callback", target.baseUrl).toString();
      // What an administrator actually knows: their tenant's issuer. Everything
      // else about the provider is discovered from it, in the browser.
      const issuerUrl = `${okta.url}/oauth2/${OKTA_AUTH_SERVER}`;

      // One client identity across both registrations (draft §5 client
      // continuity): the app the member signs in to at the identity provider is
      // the app that presents itself to the Resource Authorization Server.
      const credential = yield* Effect.promise(() =>
        okta.credentials.mint({
          type: "oauth-authorization-code",
          name: "Executor E2E enterprise client",
          redirect_uris: [executorCallback],
        }),
      );
      const clientId = requireString(credential.client_id, "IdP client_id");
      const clientSecret = requireString(credential.client_secret, "IdP client_secret");

      const integration = IntegrationSlug.make(freshSlug("mcp_ema_ui"));

      // The server starts life ORDINARY — a plain oauth2 MCP server with no
      // enterprise declaration. Everything that makes it managed happens in the
      // browser below, which is the whole point: a declaration that only ever
      // arrived through `addServer` would never exercise the save path that can
      // erase it, nor the connect path that has to notice it.
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Enterprise-managed MCP (emulate)",
          endpoint: mcpEndpoint,
          slug: String(integration),
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* browser.session(identity, async ({ page, step }) => {
            // ---------------------------------------------------------------
            // 1. The organization's identity provider, registered by issuer.
            // ---------------------------------------------------------------
            await step("An administrator opens the instance admin console", async () => {
              await visit(page, "/admin");
              await page
                .getByRole("heading", {
                  name: "Enterprise Identity Provider",
                })
                .waitFor({ timeout: 30_000 });
            });

            await step("Register the identity provider from its issuer URL", async () => {
              await page.getByRole("button", { name: "Register Provider" }).first().click();
              const dialog = page.getByRole("dialog");
              await dialog.waitFor({ timeout: 30_000 });
              await dialog.locator("#ema-idp-issuer-url").fill(issuerUrl);
              await dialog.locator("#ema-idp-client-id").fill(clientId);
              await dialog.locator("#ema-idp-client-secret").fill(clientSecret);
              await dialog.getByRole("button", { name: "Register Provider" }).click();
              // The endpoints were DISCOVERED: the row shows the token endpoint
              // the console read out of the issuer's OpenID configuration, which
              // nobody typed.
              await page
                .getByText(`${issuerUrl}/v1/token`, { exact: true })
                .waitFor({ timeout: 30_000 });
            });

            // ---------------------------------------------------------------
            // 2. The server is marked managed, and the declaration sticks.
            // ---------------------------------------------------------------
            await step("Open the MCP server they want to manage", async () => {
              await visit(page, `/integrations/${String(integration)}`);
              await page.getByRole("button", { name: "Edit" }).first().waitFor({ timeout: 30_000 });
            });

            await step("Turn on 'Managed by your organization'", async () => {
              await page.getByRole("button", { name: "Edit" }).first().click();
              const toggle = page.locator("#ema-managed-server");
              await toggle.waitFor({ timeout: 30_000 });
              expect(
                await toggle.getAttribute("data-state"),
                "an ordinary server starts unmanaged",
              ).toBe("unchecked");
              await toggle.click();
              // Waited for on the DOM rather than read once: the switch animates,
              // and this step's screenshot should show the state the
              // administrator sees, not a frame mid-transition.
              await page
                .locator('#ema-managed-server[data-state="checked"]')
                .waitFor({ timeout: 10_000 });
            });

            await step("Save — the declaration is written onto the server", async () => {
              await page.getByRole("button", { name: "Save" }).click();
              await page
                .getByText("Authentication methods updated.", { exact: true })
                .waitFor({ timeout: 30_000 });
            });

            // ---------------------------------------------------------------
            // 3. The connect modal NAMES the missing piece instead of routing
            //    around it, and the enterprise app is registered from there.
            // ---------------------------------------------------------------
            await step("Connect says the enterprise app is missing, not nothing", async () => {
              await openConnectModal(page);
              await page
                .locator('[data-slot="enterprise-app-missing-notice"]')
                .waitFor({ timeout: 30_000 });
            });

            await step("Register the server's enterprise app", async () => {
              await page.getByRole("button", { name: "Register Enterprise App" }).click();
              // The grant is not a choice here, and the resource is already the
              // server's own endpoint — both come from the declaration.
              const resource = page.locator("#ema-resource-url");
              await resource.waitFor({ timeout: 30_000 });
              expect(
                await resource.inputValue(),
                "the enterprise app is registered against the server's own endpoint",
              ).toBe(mcpEndpoint);
              await page.locator("#oauth-client-id").fill(clientId);
              await page.locator("#oauth-client-secret").fill(clientSecret);
              await page.locator("#oauth-token-url").fill(`${mcp.url}/token`);
              // No Authorization URL field, and that is the form telling the
              // truth: an enterprise-managed client never runs a browser
              // redirect at the server, and its real endpoints are discovered
              // from the resource above.
              expect(
                await page.locator("#oauth-authorization-url").count(),
                "an enterprise app has no authorize redirect to register",
              ).toBe(0);
              await page.getByRole("button", { name: "Register app", exact: true }).click();
            });

            // ---------------------------------------------------------------
            // 4. The connect: a work-identity sign-in, then a minted connection
            //    with no consent screen anywhere.
            // ---------------------------------------------------------------
            await step("The connect becomes the work identity route", async () => {
              // The button IS the assertion: registering the enterprise app is
              // what flips this server off the interactive path, and the copy is
              // what tells the member which identity they are about to use.
              await page
                .getByRole("button", { name: "Connect with Work Identity" })
                .waitFor({ timeout: 30_000 });
              await page
                .locator('[data-slot="enterprise-managed-notice"]')
                .waitFor({ timeout: 30_000 });
            });

            await step("Sign in at the identity provider's own login page", async () => {
              const popupPromise = page.waitForEvent("popup", {
                timeout: 60_000,
              });
              await page.getByRole("button", { name: "Connect with Work Identity" }).click();
              const popup = await popupPromise;
              // The window was reserved on the click and navigated once
              // `oauth.start` reported that no work identity is held yet.
              await popup.waitForURL((url) => url.origin === new URL(okta.url).origin, {
                timeout: 60_000,
              });
              await popup.waitForLoadState("domcontentloaded", {
                timeout: 30_000,
              });
              expect(
                new URL(popup.url()).pathname,
                "the sign-in lands on the identity provider's authorize endpoint",
              ).toBe(`/oauth2/${OKTA_AUTH_SERVER}/v1/authorize`);
              await popup
                .getByRole("button", { name: new RegExp(OKTA_USER) })
                .click({ timeout: 30_000 });
            });

            await step("The connection appears, managed by the organization", async () => {
              // The modal completed the link, retried the connect once, and
              // closed itself. No consent screen was shown at any point — the
              // MCP server's ledger proves that below.
              const connections = connectionsSection(page);
              await connections
                .getByText(MANAGED_BADGE, { exact: true })
                .waitFor({ timeout: 60_000 });
              await connections
                .getByText(/Revoke access at your identity provider, not here\./)
                .waitFor({ timeout: 30_000 });
            });

            await step("Its menu offers no Remove and no Reconnect", async () => {
              await connectionsSection(page)
                .locator('button[aria-haspopup="menu"]')
                .first()
                .click();
              // Present: the actions that are still the member's to take. Waited
              // for BEFORE counting absences, or an unopened menu would make
              // every absence assertion pass for the wrong reason.
              await page.getByRole("menuitem", { name: "Check now" }).waitFor({ timeout: 30_000 });
              expect(
                await page.getByRole("menuitem", { name: "Remove" }).count(),
                "an enterprise-managed connection cannot be removed locally",
              ).toBe(0);
              expect(
                await page.getByRole("menuitem", { name: "Reconnect" }).count(),
                "an enterprise-managed connection has no interactive flow to re-run",
              ).toBe(0);
              await page.keyboard.press("Escape");
            });
          });

          // ---------------------------------------------------------------
          // What the browser journey actually produced.
          // ---------------------------------------------------------------
          const connections = yield* client.connections.list({
            query: { integration },
          });
          expect(connections.length, "the browser connect minted exactly one connection").toBe(1);
          const connection = connections[0]!;
          expect(
            connection.enterpriseManaged,
            "and it reports itself managed, which is what the console branches on",
          ).toBe(true);

          // THE anti-consent claim, proven by absence: had executor fallen back
          // to the ordinary per-server flow, the MCP server would have seen an
          // authorize request or a dynamic registration.
          const mcpEntries = yield* Effect.promise(() => mcp.ledger.list());
          expect(
            mcpEntries.filter((entry) => entry.path === "/authorize" || entry.path === "/register"),
            "no per-server consent screen and no interactive client registration",
          ).toEqual([]);
          expect(
            mcpEntries.some((entry) => entry.operationId === "mcp.oauth.jwtBearer"),
            "the connection was minted by redeeming an ID-JAG at the resource authorization server",
          ).toBe(true);

          // The ONE identity event: the member signed in at their identity
          // provider, once, through the browser.
          const oktaEntries = yield* Effect.promise(() => okta.ledger.list());
          expect(
            oktaEntries.filter((entry) => entry.path.endsWith("/v1/authorize")).length,
            "the member was asked to sign in exactly once, at their own identity provider",
          ).toBe(1);
          const codeExchange = oktaEntries.find(
            (entry) =>
              entry.path.endsWith("/v1/token") &&
              (entry.request.body as { readonly grant_type?: string } | undefined)?.grant_type ===
                "authorization_code",
          );
          expect(
            codeExchange?.response.status,
            "and executor — not the browser — redeemed the code, which is the only place the IdP app's secret may be used",
          ).toBe(200);
          expect(
            oktaEntries.some((entry) => entry.operationId === "okta.oauth.tokenExchange"),
            "the connect exchanged that custody for an ID-JAG",
          ).toBe(true);

          // The connection works.
          const executed = yield* client.executions.execute({
            payload: {
              code: callGetMeCode(
                String(integration),
                String(connection.owner),
                String(connection.name),
              ),
              autoApprove: true,
            },
          });
          expect(executed.status, "the tool call completed").toBe("completed");
          expect((JSON.parse(executed.text) as { readonly ok: boolean }).ok, executed.text).toBe(
            true,
          );

          // ---------------------------------------------------------------
          // 6. The administrator denies this client at the identity provider.
          //    Clear both ledgers first so every entry below belongs to the
          //    blocked attempt.
          // ---------------------------------------------------------------
          yield* Effect.promise(() => okta.ledger.clear());
          yield* Effect.promise(() => mcp.ledger.clear());
          yield* Effect.promise(() =>
            okta.seed({
              token_exchange_policies: [
                {
                  name: "Block the executor client",
                  client_id: clientId,
                  effect: "DENY",
                },
              ],
            }),
          );

          yield* browser.session(identity, async ({ page, step }) => {
            await step("Connect now says which work identity they are signed in as", async () => {
              await visit(page, `/integrations/${String(integration)}`);
              await openConnectModal(page);
              // The link is held, so the modal names the account rather than
              // asking again — the steady state this profile is for.
              await page
                .locator('[data-slot="work-identity-label"]')
                .getByText(`linked as ${OKTA_USER}`, { exact: true })
                .waitFor({ timeout: 30_000 });
            });

            await step("A member tries to connect again after the denial", async () => {
              await page
                .getByRole("button", { name: "Connect with Work Identity" })
                .click({ timeout: 30_000 });
            });

            await step(
              "The console shows the organization's decision, and no way around it",
              async () => {
                const notice = page.locator('[data-slot="admin-block-notice"]');
                await notice.waitFor({ timeout: 60_000 });
                await notice
                  .getByText("Blocked by your organization", { exact: true })
                  .waitFor({ timeout: 30_000 });
                // The provider's own code, so a member can quote it to whoever
                // administers the policy.
                await notice
                  .getByText("Reference: invalid_target", { exact: true })
                  .waitFor({ timeout: 30_000 });
                // Nothing that reconnects. Every one of these is a route to the
                // authorization the identity provider just refused, and the
                // interactive one would route the member around it outright.
                expect(
                  await page.getByRole("button", { name: "Connect with Work Identity" }).count(),
                  "a denial is not a retry",
                ).toBe(0);
                expect(
                  await page.getByRole("button", { name: "Connect", exact: true }).count(),
                  "and no interactive fallback is offered in its place",
                ).toBe(0);
              },
            );
          });

          // Proven by absence again, on the blocked attempt this time.
          const afterDenial = yield* Effect.promise(() => mcp.ledger.list());
          expect(
            afterDenial.filter(
              (entry) =>
                entry.path === "/authorize" ||
                entry.path === "/register" ||
                entry.operationId === "mcp.oauth.jwtBearer",
            ),
            "a policy denial does not fall back to interactive OAuth",
          ).toEqual([]);
          const afterDenialConnections = yield* client.connections.list({
            query: { integration },
          });
          expect(afterDenialConnections.length, "the blocked attempt minted no connection").toBe(1);
        }),
        Effect.gen(function* () {
          const rows = yield* client.connections
            .list({ query: { integration } })
            .pipe(Effect.orElseSucceed(() => []));
          yield* Effect.forEach(
            rows,
            (row) =>
              client.connections
                .remove({
                  params: { owner: row.owner, integration, name: row.name },
                })
                .pipe(Effect.ignore),
            { discard: true },
          );
          yield* client.oauth
            .unlinkWorkIdentity({
              payload: {
                owner: "org",
                idpClient: IDP_CLIENT,
                idpClientOwner: "org",
              },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .unlinkWorkIdentity({
              payload: {
                owner: "user",
                idpClient: IDP_CLIENT,
                idpClientOwner: "org",
              },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({
              params: { slug: IDP_CLIENT },
              payload: { owner: "org" },
            })
            .pipe(Effect.ignore);
          // The enterprise app's slug is derived by the FORM from the server's
          // name, so it is not a constant here — find it by what it is.
          const clients = yield* client.oauth.listClients().pipe(Effect.orElseSucceed(() => []));
          yield* Effect.forEach(
            clients.filter((app) => app.grant === "id_jag" && app.resource === mcpEndpoint),
            (app) =>
              client.oauth
                .removeClient({
                  params: { slug: app.slug },
                  payload: { owner: app.owner },
                })
                .pipe(Effect.ignore),
            { discard: true },
          );
          yield* client.mcp.removeServer({ params: { slug: integration } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
