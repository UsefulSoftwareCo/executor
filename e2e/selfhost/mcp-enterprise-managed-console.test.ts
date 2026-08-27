// Selfhost (browser, recorded): the CONSOLE half of MCP Enterprise-Managed
// Authorization. The protocol half — the ID-JAG chain itself and the
// administrator denial — is `mcp-enterprise-managed-auth.test.ts`; this
// scenario is about what an administrator and a member can see and do.
//
// Three claims, in the order a workspace meets them:
//
//   1. An administrator marks a server as managed FROM THE UI, and that
//      declaration survives `configureMcpAuth`. It is written through the same
//      replace-mode save that rewrites the whole auth-method list, so a
//      declaration the credential editor cannot express is one unrelated edit
//      away from being erased — the assertion below is that it is not.
//   2. A member's managed connection is visibly managed and offers NO local
//      revocation. Remove would claim a revocation that did not happen (the
//      identity provider still authorizes them, and the next call hands access
//      straight back), and Reconnect re-runs a consent step this profile does
//      not have. Both belong at the identity provider.
//   3. An administrator's denial stops the connect and does NOT fall back to
//      the interactive per-server flow. The MCP emulator's ledger is the proof:
//      it shows the requests executor did NOT make.
//
// Two emulators stand in for the pilot's real parties: `okta` is the customer's
// identity provider (it runs the real OIDC sign-on, mints ID-JAGs over RFC 8693
// and enforces an administrator policy table), `mcp` is the third-party server
// and its Resource Authorization Server.
//
// GAP, deliberately not papered over: minting the connection below goes through
// the typed API, not the console, because `oauth.start`'s `enterprise` input
// requires the caller to HOLD the identity assertion and no browser surface can
// obtain one. See the branch's report; the console work here is everything
// around that one leg.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { assert, expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

const OKTA_USER = "testuser@okta.local";
const OKTA_AUTH_SERVER = "default";
const SSO_REDIRECT_URI = "http://localhost:3000/callback";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

// The reserved (owner, slug) the organization's identity provider is registered
// under — the SAME identity the org settings section writes, so a server marked
// managed in the console names exactly this app. Self-host has no organization
// admin page, so the registration is seeded through the typed API here; the
// browser drives everything downstream of it.
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

/** Single sign-on at the identity provider, ending with the ID token the host
 *  holds on the member's behalf. THE one step this console cannot yet perform
 *  for itself — see the header. */
const singleSignOn = (input: {
  readonly issuerBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) =>
  Effect.promise(async (): Promise<string> => {
    const authorize = await fetch(
      `${input.issuerBaseUrl}/oauth2/${OKTA_AUTH_SERVER}/v1/authorize/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
        body: new URLSearchParams({
          user_ref: OKTA_USER,
          redirect_uri: SSO_REDIRECT_URI,
          scope: "openid profile email",
          client_id: input.clientId,
          response_mode: "query",
          auth_server_id: OKTA_AUTH_SERVER,
        }),
      },
    );
    if (authorize.status !== 302) {
      throw new Error(`IdP authorize answered ${authorize.status}, expected a 302`);
    }
    const location = requireString(authorize.headers.get("location"), "authorize redirect");
    const code = requireString(new URL(location).searchParams.get("code"), "authorization code");

    const token = await fetch(`${input.issuerBaseUrl}/oauth2/${OKTA_AUTH_SERVER}/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: SSO_REDIRECT_URI,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    });
    if (!token.ok) throw new Error(`IdP token endpoint answered ${token.status}`);
    const body = (await token.json()) as { readonly id_token?: string };
    return requireString(body.id_token, "id_token");
  });

const connectionsSection = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { level: 3, name: "Connections" }),
  });

const callGetMeCode = (slug: string, connection: string) => `
const result = await tools.${slug}.org.${connection}.get_me({});
return { ok: result.ok, payload: result.ok ? result.data : result.error };
`;

scenario(
  "MCP enterprise-managed authorization (console) · an administrator marks a server managed, and the managed connection offers no local revocation",
  { timeout: 240_000 },
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

      // One client identity across both registrations (draft §5 client
      // continuity): the app the member signs in to at the identity provider is
      // the app that presents itself to the Resource Authorization Server.
      const credential = yield* Effect.promise(() =>
        okta.credentials.mint({
          type: "oauth-authorization-code",
          name: "Executor E2E enterprise client",
          redirect_uris: [SSO_REDIRECT_URI],
        }),
      );
      const clientId = requireString(credential.client_id, "IdP client_id");
      const clientSecret = requireString(credential.client_secret, "IdP client_secret");
      const idpTokenUrl = requireString(credential.token_url, "IdP token endpoint");
      const idpAuthorizationUrl = requireString(credential.authorization_url, "IdP authorize URL");

      const subjectToken = yield* singleSignOn({
        issuerBaseUrl: okta.url,
        clientId,
        clientSecret,
      });

      const integration = IntegrationSlug.make(freshSlug("mcp_ema_ui"));
      const serverClient = OAuthClientSlug.make(freshSlug("ema_server"));
      const template = AuthTemplateSlug.make("oauth2");
      const managedConnection = ConnectionName.make("main");

      // The server starts life ORDINARY — a plain oauth2 MCP server with no
      // enterprise declaration. Marking it managed is the browser's job below,
      // which is the whole point: a declaration that only ever arrives through
      // `addServer` would never exercise the save path that can erase it.
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
          // The organization's identity provider, under the reserved identity
          // the org settings section owns. Both endpoints are recorded exactly
          // as that section records them.
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: IDP_CLIENT,
              authorizationUrl: idpAuthorizationUrl,
              tokenUrl: idpTokenUrl,
              grant: "authorization_code",
              clientId,
              clientSecret,
            },
          });
          // The server-side registration an administrator makes through the
          // OAuth app form's "Enterprise identity assertion" grant: `id_jag`
          // plus the RFC 9728 resource discovery starts from.
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: serverClient,
              authorizationUrl: `${mcp.url}/authorize`,
              tokenUrl: `${mcp.url}/token`,
              grant: "id_jag",
              clientId,
              clientSecret,
              resource: mcpEndpoint,
            },
          });

          // -----------------------------------------------------------------
          // 1. The administrator marks the server managed, in the console.
          // -----------------------------------------------------------------
          yield* browser.session(identity, async ({ page, step }) => {
            await step("An administrator opens the MCP server they want to manage", async () => {
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
              // Waited for on the DOM rather than read once: the switch
              // animates, and this step's screenshot should show the state the
              // administrator sees, not a frame mid-transition.
              await page
                .locator('#ema-managed-server[data-state="checked"]')
                .waitFor({ timeout: 10_000 });
              await page
                .locator('#ema-managed-server [data-slot="switch-thumb"][data-state="checked"]')
                .waitFor({ timeout: 10_000 });
            });

            await step("Save — the declaration is written onto the server", async () => {
              await page.getByRole("button", { name: "Save" }).click();
              await page
                .getByText("Authentication methods updated.", { exact: true })
                .waitFor({ timeout: 30_000 });
            });

            await step("Reopening the server shows it is still managed", async () => {
              // Not a repeat of the save assertion: this reads the toggle back
              // from the SERVER's stored declaration on a fresh mount, which is
              // the state a second administrator would arrive at.
              await page.getByRole("button", { name: "Edit" }).first().click();
              const reopened = page.locator('#ema-managed-server[data-state="checked"]');
              await reopened.waitFor({ timeout: 30_000 });
              // Left open, and scrolled to: this step's screenshot is the
              // artifact showing the stored declaration as an administrator
              // finds it.
              await reopened.scrollIntoViewIfNeeded();
            });
          });

          // The declaration reached storage AND survived the replace-mode save
          // that rewrote the whole method list. Read back through the catalog,
          // which is where every connect path learns of it.
          const catalog = yield* client.integrations.get({ params: { slug: integration } });
          const declared = catalog.authMethods.find((method) => method.kind === "oauth");
          expect(
            declared?.oauth?.enterpriseIdentityProvider,
            "the console's toggle declared the organization's identity provider on this server",
          ).toEqual({ client: String(IDP_CLIENT), clientOwner: "org" });
          expect(
            declared?.oauth?.supportsDynamicRegistration,
            "declaring an identity provider leaves the interactive route advertised",
          ).toBe(true);
          const enterprise = declared?.oauth?.enterpriseIdentityProvider;
          assert(enterprise, "the connect below drives off the projected pointer");

          // -----------------------------------------------------------------
          // 2. A member connects with their work identity, and uses the server.
          //    This leg goes through the typed API — see the file header.
          // -----------------------------------------------------------------
          const connected = yield* client.oauth.start({
            payload: {
              owner: "org",
              client: serverClient,
              clientOwner: "org",
              name: managedConnection,
              integration,
              template,
              enterprise: {
                idpClient: enterprise.client,
                idpClientOwner: enterprise.clientOwner,
                subjectToken,
                subjectTokenType: ID_TOKEN_TYPE,
              },
            },
          });
          assert(
            connected.status === "connected",
            "the enterprise grant connects with no authorize redirect",
          );
          expect(
            connected.connection.enterpriseManaged,
            "the connection reports itself managed, which is what the console branches on",
          ).toBe(true);

          const executed = yield* client.executions.execute({
            payload: {
              code: callGetMeCode(String(integration), String(managedConnection)),
              autoApprove: true,
            },
          });
          expect(executed.status, "the tool call completed").toBe("completed");
          expect((JSON.parse(executed.text) as { readonly ok: boolean }).ok, executed.text).toBe(
            true,
          );

          // -----------------------------------------------------------------
          // 3. The member's view of the managed connection.
          // -----------------------------------------------------------------
          yield* browser.session(identity, async ({ page, step }) => {
            const connections = connectionsSection(page);
            const menuTrigger = connections.locator('button[aria-haspopup="menu"]').first();

            await step("A member opens the managed server's connections", async () => {
              await visit(page, `/integrations/${String(integration)}`);
              await connections
                .getByText(String(managedConnection), { exact: true })
                .waitFor({ timeout: 30_000 });
            });

            await step("The connection is visibly managed by the organization", async () => {
              await connections.getByText(MANAGED_BADGE, { exact: true }).waitFor({
                timeout: 30_000,
              });
              // The badge is a claim; this is the consequence of it, said in
              // words the member can act on.
              await connections
                .getByText(/Revoke access at your identity provider, not here\./)
                .waitFor({ timeout: 30_000 });
            });

            await step("Its menu offers no Remove and no Reconnect", async () => {
              await menuTrigger.click();
              // Present: the actions that are still the member's to take.
              await page.getByRole("menuitem", { name: "Check now" }).waitFor({ timeout: 30_000 });
              await page.getByRole("menuitem", { name: "Edit" }).waitFor({ timeout: 30_000 });
              // Absent: WITHHELD, not disabled. A local Remove would claim a
              // revocation that did not happen, and Reconnect re-runs a consent
              // step this profile does not have.
              expect(
                await page.getByRole("menuitem", { name: "Remove" }).count(),
                "an enterprise-managed connection cannot be removed locally",
              ).toBe(0);
              expect(
                await page.getByRole("menuitem", { name: "Reconnect" }).count(),
                "an enterprise-managed connection has no interactive flow to re-run",
              ).toBe(0);
              // Left open on purpose: this step's screenshot is the artifact
              // that shows the menu as the member sees it.
            });
          });

          // -----------------------------------------------------------------
          // 4. The administrator denies this client at the identity provider.
          //    Clear both ledgers first so every entry below belongs to the
          //    blocked attempt.
          // -----------------------------------------------------------------
          yield* Effect.promise(() => okta.ledger.clear());
          yield* Effect.promise(() => mcp.ledger.clear());
          yield* Effect.promise(() =>
            okta.seed({
              token_exchange_policies: [
                { name: "Block the executor client", client_id: clientId, effect: "DENY" },
              ],
            }),
          );

          const blocked = yield* client.oauth
            .start({
              payload: {
                owner: "org",
                client: serverClient,
                clientOwner: "org",
                name: ConnectionName.make("blocked"),
                integration,
                template,
                enterprise: {
                  idpClient: enterprise.client,
                  idpClientOwner: enterprise.clientOwner,
                  subjectToken,
                  subjectTokenType: ID_TOKEN_TYPE,
                },
              },
            })
            .pipe(Effect.flip);

          assert(
            Predicate.isTagged(blocked, "OAuthStartError"),
            "a policy denial is a start failure, not a transport or decoding fault",
          );
          // The two fields the console branches on. It must never decide this
          // from the wording of a message: getting it wrong means offering the
          // interactive flow, which walks the member around the control the
          // identity provider just exercised.
          expect(blocked.blockedByAdmin, "the denial reaches the console as a FIELD").toBe(true);
          expect(
            blocked.oauthErrorCode,
            "the provider's own code travels structurally, so support can trace it",
          ).toBe("invalid_target");

          // THE anti-fallback claim, proven by absence: had executor quietly
          // offered the ordinary per-server flow, the MCP server would have seen
          // an authorize request, a registration, or another redemption.
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

          const connections = yield* client.connections.list({ query: { integration } });
          expect(
            connections.map((connection) => String(connection.name)).sort(),
            "the blocked attempt minted no connection",
          ).toEqual([String(managedConnection)]);

          // -----------------------------------------------------------------
          // 5. The denial changes nothing the console offers: the managed row
          //    still has no route around the identity provider's decision.
          // -----------------------------------------------------------------
          yield* browser.session(identity, async ({ page, step }) => {
            const rows = connectionsSection(page);
            await step("After the denial, the console still offers no way around it", async () => {
              await visit(page, `/integrations/${String(integration)}`);
              await rows
                .getByText(String(managedConnection), { exact: true })
                .waitFor({ timeout: 30_000 });
              await rows.getByText(MANAGED_BADGE, { exact: true }).waitFor({ timeout: 30_000 });
              await rows.locator('button[aria-haspopup="menu"]').first().click();
              // Wait for a menu item that IS there before counting the ones
              // that are not: an unopened menu would make every absence
              // assertion below pass for the wrong reason.
              await page.getByRole("menuitem", { name: "Check now" }).waitFor({ timeout: 30_000 });
              expect(
                await page.getByRole("menuitem", { name: "Reconnect" }).count(),
                "the interactive route is exactly what the identity provider closed",
              ).toBe(0);
              expect(
                await page.getByRole("menuitem", { name: "Remove" }).count(),
                "and a denial does not turn revocation into a local action either",
              ).toBe(0);
            });
          });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: { owner: "org", integration, name: managedConnection },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: serverClient }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: IDP_CLIENT }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.mcp.removeServer({ params: { slug: integration } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
