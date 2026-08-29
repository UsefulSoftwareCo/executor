// Selfhost repro for #1542: a dynamically registered (RFC 7591) OAuth client is
// bound to the exact callback URL it registered with the authorization server.
// Executor's callback origin is not stable for the life of a connection (a
// desktop sidecar on 127.0.0.1 vs a CLI daemon on localhost, or a self-hosted
// instance that moves domain), so a DCR client can outlive the origin it was
// registered for. Reconnect used to re-send that stranded client on every
// attempt — the authorization server answered `invalid_request: redirect_uri
// is not registered` forever, and the only exit was deleting the OAuth app by
// hand. Add connection recovered (probe → register-dynamic → start reaches the
// #1443 reuse gate); Reconnect did not.
//
// The contract under test: Reconnect takes the same probe → register-dynamic →
// start route as the initial connect, so the registration gate declines the
// redirect-mismatched client, mints a fresh one bound to the CURRENT callback,
// and re-minting rebinds the SAME connection row — no orphaned grant state.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

const name = ConnectionName.make("main");
const template = AuthTemplateSlug.make("oauth2");

/** The callback the DCR client was registered under — an origin the app no
 *  longer serves. Only its string identity matters: seeding completes the
 *  authorization out of band, so nothing ever listens here (mirrors the
 *  desktop-sidecar origin from the report). */
const STALE_REDIRECT_URI = "http://127.0.0.1:64999/api/oauth/callback";

/** Client the authorization server knows UP FRONT (`clients` option below) —
 *  the bring-your-own-app case. Reconnect must keep using it directly: routing
 *  it through probe/registration would rebind the connection to an auto-minted
 *  client behind the user's back. */
const STATIC_CLIENT_ID = "static-byo-client";
const STATIC_CLIENT_SECRET = "static-byo-secret";

const connectionsSection = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { level: 3, name: "Connections" }),
  });

const connectionRow = (page: Page, label: string) =>
  connectionsSection(page)
    .locator('[data-slot="card-stack-entry"]')
    .filter({ has: page.getByText(label, { exact: true }) });

const requiredRedirect = (response: Response, from: string): string => {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Expected redirect from ${from}, got HTTP ${response.status}`);
  }
  return new URL(location, from).toString();
};

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

const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const login = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = requiredRedirect(login, authorizationUrl);
    const callbackUrl = await submitProviderLogin(loginUrl);
    const parsed = new URL(callbackUrl);
    const code = parsed.searchParams.get("code");
    if (!code) throw new Error(`OAuth callback did not include a code: ${callbackUrl}`);
    return { code };
  });

scenario(
  "MCP OAuth · reconnect recovers a DCR connection whose callback origin changed",
  { timeout: 420_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const oauth = yield* serveOAuthTestServer({
        scopes: ["channels:history", "users:read"],
        clients: { [STATIC_CLIENT_ID]: STATIC_CLIENT_SECRET },
      });

      const slug = IntegrationSlug.make(`mcp-origin-drift-${randomBytes(4).toString("hex")}`);
      const clientSlug = OAuthClientSlug.make(`origin-drift-${randomBytes(4).toString("hex")}`);

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: `Origin drift repro ${String(slug)}`,
          endpoint: oauth.mcpResourceUrl,
          slug: String(slug),
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
      );
      // The recovery mints a fresh server-slugged client mid-scenario; the org
      // is scenario-fresh, so reap every client it accumulated rather than
      // guessing derived slugs.
      yield* Effect.addFinalizer(() =>
        client.oauth.listClients().pipe(
          Effect.flatMap((clients) =>
            Effect.forEach(clients, (candidate) =>
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

      // Seed the stranded state from the report: the DCR client registers the
      // STALE callback with the authorization server (as if minted weeks ago
      // under the old origin), and the connection completes against it out of
      // band — so the connection is live while its client is bound to a
      // callback the app no longer serves.
      const probe = yield* client.oauth.probe({ payload: { url: oauth.mcpResourceUrl } });
      if (!probe.registrationEndpoint) {
        return yield* Effect.die("OAuth probe did not discover a DCR registration endpoint");
      }
      const registered = yield* client.oauth.registerDynamic({
        payload: {
          owner: "org",
          slug: clientSlug,
          issuer: probe.issuer ?? null,
          registrationEndpoint: probe.registrationEndpoint,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource ?? oauth.mcpResourceUrl,
          scopes: probe.scopesSupported ?? [],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Executor e2e origin drift repro",
          redirectUri: STALE_REDIRECT_URI,
          originIntegration: slug,
        },
      });
      const started = yield* client.oauth.start({
        payload: {
          owner: "org",
          client: registered.client,
          clientOwner: "org",
          name,
          integration: slug,
          template,
          redirectUri: STALE_REDIRECT_URI,
        },
      });
      expect(started.status, "seeding starts an authorization-code redirect").toBe("redirect");
      if (started.status !== "redirect") return yield* Effect.die("OAuth start did not redirect");
      const callback = yield* completeAuthorization(started.authorizationUrl);
      yield* client.oauth.complete({ payload: { state: started.state, code: callback.code } });
      yield* Effect.addFinalizer(() =>
        client.connections
          .remove({ params: { owner: "org", integration: slug, name } })
          .pipe(Effect.ignore),
      );

      // Wire truth for the seeded trap: the AS holds exactly one registration,
      // and it is bound to the stale callback.
      const seedRequests = yield* oauth.requests;
      const seedRegistrations = seedRequests.filter(
        (request) => request.method === "POST" && request.path === "/register",
      );
      expect(seedRegistrations, "seeding registered exactly one client").toHaveLength(1);
      expect(
        seedRegistrations[0]?.body ?? "",
        "the seeded client is bound to the stale callback",
      ).toContain(STALE_REDIRECT_URI);

      // A second connection on the SAME discovery-capable integration, backed
      // by a STATIC (BYO) client the authorization server already knows. Its
      // seeding start omits `redirectUri`, so it binds to the callback the app
      // serves NOW — nothing about it needs recovery, and reconnect must leave
      // its client binding alone.
      const staticName = ConnectionName.make("static");
      const staticSlug = OAuthClientSlug.make(`static-byo-${randomBytes(4).toString("hex")}`);
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: staticSlug,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          grant: "authorization_code",
          clientId: STATIC_CLIENT_ID,
          clientSecret: STATIC_CLIENT_SECRET,
          originIntegration: slug,
        },
      });
      const staticStarted = yield* client.oauth.start({
        payload: {
          owner: "org",
          client: staticSlug,
          clientOwner: "org",
          name: staticName,
          integration: slug,
          template,
        },
      });
      expect(staticStarted.status, "static seeding starts an authorization-code redirect").toBe(
        "redirect",
      );
      if (staticStarted.status !== "redirect") {
        return yield* Effect.die("static OAuth start did not redirect");
      }
      const staticCallback = yield* completeAuthorization(staticStarted.authorizationUrl);
      yield* client.oauth.complete({
        payload: { state: staticStarted.state, code: staticCallback.code },
      });
      yield* Effect.addFinalizer(() =>
        client.connections
          .remove({ params: { owner: "org", integration: slug, name: staticName } })
          .pipe(Effect.ignore),
      );
      yield* oauth.clearRequests;

      // One Reconnect journey: open the row's menu, complete the provider
      // login in the popup, and wait for the success toast. Visits the
      // integration page first so a toast from an earlier reconnect can never
      // satisfy this one's wait.
      const reconnectThroughUi = (label: string, description: string) =>
        browser.session(identity, async ({ page, step }) => {
          const connections = connectionsSection(page);
          await step(`Open the MCP integration and find the ${label} connection`, async () => {
            await visit(page, `/integrations/${String(slug)}`);
            await connections.getByText(label, { exact: true }).waitFor({ timeout: 30_000 });
          });

          await step(description, async () => {
            const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
            await connectionRow(page, label).locator('button[aria-haspopup="menu"]').click();
            await page.getByRole("menuitem", { name: "Reconnect" }).click();
            const popup = await popupPromise;

            // #1542's dead end lived here: reconnect re-sent the stranded client,
            // so the popup landed on the authorization server's `invalid_request:
            // redirect_uri is not registered` JSON and never reached the login
            // page. Surface that page instead of a bare timeout when it regresses.
            try {
              await popup.waitForURL(/\/login\?/, { timeout: 30_000 });
            } catch (cause) {
              const body = await popup
                .locator("body")
                .innerText()
                .catch(() => "<unreadable>");
              throw new Error(
                `Reconnect dead-ended before the provider login page. ` +
                  `Popup URL: ${popup.url()}; body: ${body}`,
                { cause },
              );
            }
            // The test AS login page is plain text driven by Basic-auth POST, so
            // complete it out of band and drive the popup to the callback — the
            // same journey a user's click-through consent takes.
            const callbackUrl = await submitProviderLogin(popup.url());
            await popup.goto(callbackUrl);
            await page.getByText("Reconnected", { exact: true }).waitFor({ timeout: 30_000 });
          });
        });

      const registrationsIn = <R extends { readonly method: string; readonly path: string }>(
        requests: readonly R[],
      ): readonly R[] =>
        requests.filter((request) => request.method === "POST" && request.path === "/register");
      const dcrClientCount = Effect.map(
        client.oauth.listClients(),
        (clients) =>
          clients.filter((candidate) => candidate.origin.kind === "dynamic_client_registration")
            .length,
      );
      const mainConnection = client.connections.get({
        params: { owner: "org", integration: slug, name },
      });

      yield* reconnectThroughUi("main", "Reconnect the drifted connection and complete OAuth");

      // Wire truth for the recovery: reconnect re-registered EXACTLY ONE client
      // for the callback the app serves NOW instead of re-sending the stranded
      // one, and the authorization it started used that fresh registration.
      const recoveryRequests = yield* oauth.requests;
      const recoveryRegistrations = registrationsIn(recoveryRequests);
      expect(
        recoveryRegistrations,
        "the drift reconnect registers exactly one fresh client",
      ).toHaveLength(1);
      expect(
        recoveryRegistrations[0]?.body ?? "",
        "the fresh registration is bound to the current callback, not the stale one",
      ).not.toContain(STALE_REDIRECT_URI);
      expect(
        recoveryRegistrations[0]?.body ?? "",
        "the fresh registration carries the app's callback path",
      ).toContain("/api/oauth/callback");
      const authorize = recoveryRequests.find(
        (request) => request.method === "GET" && request.path === "/authorize",
      );
      expect(authorize, "the popup reached the authorize endpoint").toBeDefined();
      // The stranded client row deliberately survives (it stays valid for
      // refresh, and `createClient` must never clobber it) — the recovery adds
      // exactly ONE freshly bound client rather than editing the stranded one.
      expect(
        yield* dcrClientCount,
        "the stranded DCR client survives alongside exactly one fresh registration",
      ).toBe(2);
      const mainAfterRecovery = yield* mainConnection;
      expect(
        String(mainAfterRecovery.oauthClient),
        "the connection is rebound off the stranded client",
      ).not.toBe(String(clientSlug));
      yield* oauth.clearRequests;

      // A SECOND reconnect at the SAME origin must reuse the recovery client:
      // zero additional registrations, zero additional client rows, and the
      // connection keeps the binding the recovery minted. Registering again on
      // every reconnect after the first drift is the regression class here.
      yield* reconnectThroughUi("main", "Reconnect again at the same origin");
      const repeatRequests = yield* oauth.requests;
      expect(
        registrationsIn(repeatRequests),
        "a reconnect at an unchanged origin registers nothing",
      ).toHaveLength(0);
      expect(
        repeatRequests.filter(
          (request) => request.method === "GET" && request.path === "/authorize",
        ),
        "the repeat reconnect still ran a real authorization",
      ).toHaveLength(1);
      expect(yield* dcrClientCount, "no additional DCR client row is minted").toBe(2);
      const mainAfterRepeat = yield* mainConnection;
      expect(
        String(mainAfterRepeat.oauthClient),
        "the repeat reconnect reuses the recovery client binding",
      ).toBe(String(mainAfterRecovery.oauthClient));
      yield* oauth.clearRequests;

      // The static (BYO) connection reconnects DIRECTLY through its stored
      // client: no probe-driven registration, and the binding is untouched —
      // a discovery-capable integration must not hijack a static binding into
      // the automatic flow.
      yield* reconnectThroughUi("static", "Reconnect the static-client connection");
      const staticRequests = yield* oauth.requests;
      expect(
        registrationsIn(staticRequests),
        "a static-client reconnect never touches the registration endpoint",
      ).toHaveLength(0);
      expect(
        staticRequests.filter(
          (request) => request.method === "GET" && request.path === "/authorize",
        ),
        "the static reconnect ran a real authorization",
      ).toHaveLength(1);
      expect(yield* dcrClientCount, "the static reconnect mints no DCR client").toBe(2);
      const staticConnection = yield* client.connections.get({
        params: { owner: "org", integration: slug, name: staticName },
      });
      expect(
        String(staticConnection.oauthClient),
        "the static connection keeps its BYO client binding",
      ).toBe(String(staticSlug));

      // No orphaned grant state: the SAME connection rows are rebound and both
      // grants are healthy end to end.
      const health = yield* client.connections.checkHealth({
        params: { owner: "org", integration: slug, name },
        query: {},
      });
      expect(health.status, "the reconnected grant is healthy").toBe("healthy");
      const staticHealth = yield* client.connections.checkHealth({
        params: { owner: "org", integration: slug, name: staticName },
        query: {},
      });
      expect(staticHealth.status, "the static grant is healthy after reconnect").toBe("healthy");
    }),
  ),
);
