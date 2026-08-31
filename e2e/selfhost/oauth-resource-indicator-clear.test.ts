// Selfhost (browser): clearing the "Resource indicator" field on the
// Register-OAuth-app form is a persisted decision, not a display quirk.
//
// The reported journey (#1789): an MCP server sits behind an authorization
// server that rejects anonymous DCR, so automatic setup falls back to
// bring-your-own-app registration. The form prefills the RFC 8707 resource
// indicator with the MCP endpoint — but some authorization servers (Microsoft
// Entra v2, AADSTS9010010) reject any request that carries `resource`, so the
// user clears the field. The product guarantee under test:
//   1. blank normalizes to null and persists as absent,
//   2. the authorize request the server receives carries NO resource parameter
//      (and the token exchange doesn't either),
//   3. scope discovery still works without a persisted resource (the
//      integration's own discovery URL takes over), and
//   4. reopening the app's edit form shows the field still empty — clearing
//      stuck; nothing re-derived an endpoint over the intentional absence.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

// The scopes the test AS advertises in its RFC 8414 metadata. The client
// persists no resource, so discovering these proves the connect path fell back
// to the integration's own discovery URL for protected-resource metadata.
const ADVERTISED_SCOPES = ["channels:history", "users:read"] as const;

/** The test server's login page is plain text with Basic-auth POST — nothing a
 *  browser can click. Complete it out of band and hand back the callback URL. */
const submitProviderLogin = async (loginUrl: string): Promise<string> => {
  const credentials = Buffer.from("alice:password").toString("base64");
  const response = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Basic ${credentials}` },
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    throw new Error(`provider login did not redirect (${response.status})`);
  }
  return new URL(location, loginUrl).toString();
};

scenario(
  "OAuth client · a cleared resource indicator persists and the authorize request omits RFC 8707",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // An authorization server that rejects anonymous DCR (the Entra shape):
      // /register answers 400, so the connect modal falls back to the manual
      // Register-OAuth-app form — the surface under test.
      const oauth = yield* serveOAuthTestServer({
        scopes: [...ADVERTISED_SCOPES],
        approveRedirectUri: () => false,
      });

      const slug = IntegrationSlug.make(`resource-clear-${randomBytes(4).toString("hex")}`);
      // Lowercase+digits so slug === appName, and the actions menu is
      // addressable as `Actions for ${appName}`.
      const appName = `resourceclearapp${randomBytes(4).toString("hex")}`;

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: `Resource clear ${String(slug)}`,
          endpoint: oauth.mcpResourceUrl,
          slug: String(slug),
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
      );
      // The app is registered through the browser mid-scenario; reap it by slug
      // whatever owner the form saved it under.
      yield* Effect.addFinalizer(() =>
        client.oauth.listClients().pipe(
          Effect.flatMap((clients) =>
            Effect.forEach(
              clients.filter((candidate) => String(candidate.slug) === appName),
              (candidate) =>
                client.oauth
                  .removeClient({
                    params: { slug: candidate.slug },
                    payload: { owner: candidate.owner },
                  })
                  .pipe(Effect.ignore),
            ),
          ),
          Effect.ignore,
        ),
      );
      // The connection is minted through the popup with a server-derived name;
      // list-and-remove rather than guessing it.
      yield* Effect.addFinalizer(() =>
        client.connections.list({ query: { integration: slug } }).pipe(
          Effect.flatMap((connections) =>
            Effect.forEach(connections, (connection) =>
              client.connections
                .remove({
                  params: {
                    owner: connection.owner,
                    integration: connection.integration,
                    name: connection.name,
                  },
                })
                .pipe(Effect.ignore),
            ),
          ),
          Effect.ignore,
        ),
      );

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Automatic setup fails — the AS rejects dynamic registration", async () => {
          await visit(page, `/integrations/${String(slug)}`);
          await page.getByRole("button", { name: "Add connection" }).first().click();
          await page.getByRole("heading", { name: /Add connection/ }).waitFor();
          await page.getByRole("button", { name: "Connect", exact: true }).click();
          // DCR 400s → the modal drops to the register-an-app recovery view.
          await page
            .getByRole("button", { name: "Manually register an app" })
            .waitFor({ timeout: 30_000 });
        });

        await step("Register an app, clearing the prefilled resource indicator", async () => {
          await page.getByRole("button", { name: "Manually register an app" }).click();
          await page.getByRole("heading", { name: "Register OAuth app" }).waitFor();
          // Prefilled endpoints collapse into a summary row; the resource
          // indicator lives inside, so expand it the way a user would.
          await page.getByRole("button", { name: "Endpoints set from" }).click();
          // The field arrives prefilled with the MCP endpoint — clearing it is
          // a deliberate choice, not a no-op on an empty field.
          const resource = page.locator("#oauth-resource");
          await expect.poll(() => resource.inputValue()).toBe(oauth.mcpResourceUrl);
          await page.locator("#oauth-app-name").fill(appName);
          await page.locator("#oauth-client-id").fill("test-client");
          await page.locator("#oauth-client-secret").fill("test-secret");
          await resource.fill("");
          await page.getByRole("button", { name: "Register app", exact: true }).click();
          await page
            .getByRole("heading", { name: "Register OAuth app" })
            .waitFor({ state: "hidden", timeout: 20_000 });
        });

        await step("Connect with the registered app and complete authorization", async () => {
          const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
          await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
          const popup = await popupPromise;
          // The test AS login page is plain text driven by Basic-auth POST, so
          // complete it out of band and drive the popup to the callback — the
          // same journey a user's click-through consent takes.
          await popup.waitForURL(/\/login\?/, { timeout: 30_000 });
          const callbackUrl = await submitProviderLogin(popup.url());
          await popup.goto(callbackUrl);
          await page.getByText("Connection added", { exact: true }).waitFor({ timeout: 30_000 });
        });
      });

      // The wire truth, from the authorization server's own request log: the
      // authorize request carried NO RFC 8707 resource parameter — while scope
      // discovery still produced the advertised scopes (the integration's
      // discovery URL covered for the absent client resource).
      const requests = yield* oauth.requests;
      const authorize = requests.find(
        (request) => request.method === "GET" && request.path === "/authorize",
      );
      expect(authorize, "the popup reached the authorize endpoint").toBeDefined();
      expect(
        "resource" in (authorize?.query ?? {}),
        `the authorize request carries no resource parameter (query: ${JSON.stringify(
          authorize?.query,
        )})`,
      ).toBe(false);
      for (const scope of ADVERTISED_SCOPES) {
        expect(
          authorize?.query["scope"] ?? "",
          "scope discovery still works without a persisted resource",
        ).toContain(scope);
      }
      const tokenExchange = requests.find(
        (request) =>
          request.method === "POST" &&
          request.path === "/token" &&
          request.body.includes("grant_type=authorization_code"),
      );
      expect(tokenExchange, "the code was exchanged at the token endpoint").toBeDefined();
      expect(
        tokenExchange?.body.includes("resource="),
        "the token exchange carries no resource parameter",
      ).toBe(false);

      // Blank persisted as ABSENT on the stored client, not as "".
      const saved = (yield* client.oauth.listClients()).find(
        (candidate) => String(candidate.slug) === appName,
      );
      expect(saved, "the browser-registered app is in the catalog").toBeDefined();
      expect(saved?.resource ?? null, "a cleared resource persists as absent").toBeNull();

      // Reopening the form: the cleared field STAYS empty. A DCR-capable method
      // only shows the app picker after automatic setup falls back, so take the
      // same path a returning user would.
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Reach the app picker again through the failed automatic setup", async () => {
          await visit(page, `/integrations/${String(slug)}`);
          await page.getByRole("button", { name: "Add connection" }).first().click();
          await page.getByRole("heading", { name: /Add connection/ }).waitFor();
          await page.getByRole("button", { name: "Connect", exact: true }).click();
          await page
            .getByRole("button", { name: `Actions for ${appName}` })
            .waitFor({ timeout: 30_000 });
        });

        await step("The reopened app shows an empty resource indicator", async () => {
          await page.getByRole("button", { name: `Actions for ${appName}` }).click();
          await page.getByRole("menuitem", { name: "Edit" }).click();
          await page.getByText(`Edit ${appName}`).waitFor();
          // The prefill has landed once the stored client id is shown.
          await expect
            .poll(() => page.locator("#oauth-client-id").inputValue())
            .toBe("test-client");
          // The stored endpoints collapse here too; expand to reach the field.
          await page.getByRole("button", { name: "Endpoints set from" }).click();
          expect(
            await page.locator("#oauth-resource").inputValue(),
            "the cleared resource indicator stays empty on reopen",
          ).toBe("");
        });
      });
    }),
  ),
);
