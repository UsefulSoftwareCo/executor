// Selfhost-only: EXECUTOR_OAUTH_DISABLE_CIMD is the private-network operator
// opt-out for automatic OAuth connects. A CIMD client_id is a URL on the
// deployment itself that the provider's authorization server must fetch, which
// a host that is not publicly reachable can never serve. With the flag set, a
// server that advertises Client ID Metadata Documents alongside dynamic
// registration is connected through DCR instead: the probe reports CIMD
// unsupported, a dynamic-registration request mints the client, and
// authorization starts with that minted client_id, never the hosted
// metadata-document URL.
//
// Why this scenario boots its OWN instance instead of using the shared one:
// the opt-out is a BOOT-TIME operator knob, and setting it on the shared
// instance would invert what mcp-oauth-cimd-connect.test.ts asserts underneath
// every other selfhost scenario. A dedicated instance on its own port and data
// dir keeps the flag contained to this file (the same pattern as
// mcp-session-idle-eviction.test.ts).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeGreetingMcpServer, serveMcpServerWithOAuth } from "@executor-js/plugin-mcp/testing";
import { OAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { claimAndBoot } from "../src/ports";
import { Browser, RunDir } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { isBootReadinessTimeout } from "../setup/boot";
import { bootSelfhost } from "../setup/selfhost.boot";
import { SELFHOST_ADMIN, signInSession } from "../targets/selfhost";

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
  "MCP OAuth · EXECUTOR_OAUTH_DISABLE_CIMD connects through dynamic registration",
  // Own vite dev boot (cold on a fresh checkout) needs materially more than
  // the project's 180s default; same budget as mcp-session-idle-eviction.
  { timeout: 420_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Browser;
      const runDir = yield* RunDir;
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: "no-cimd-connect-mcp" }),
        { path: "/mcp" },
      );

      const dataDir = mkdtempSync(join(tmpdir(), "executor-selfhost-no-cimd-"));

      // A distinct env var (not E2E_SELFHOST_PORT, which the shared instance
      // has already published into this worker's env) so the claim actually
      // probes and locks a free port instead of returning the shared one.
      const booted = yield* Effect.promise(() =>
        claimAndBoot(
          [{ envVar: "E2E_SELFHOST_NO_CIMD_PORT", offset: 7, label: "selfhost no-cimd vite dev" }],
          async (ports) => {
            const port = ports.E2E_SELFHOST_NO_CIMD_PORT!;
            const baseUrl = `http://localhost:${port}`;
            const procs = await bootSelfhost({
              port,
              webBaseUrl: baseUrl,
              admin: SELFHOST_ADMIN,
              dataDir,
              logFile: join(runDir, "no-cimd-boot.log"),
              oauthDisableCimd: true,
            });
            return { teardown: procs.teardown, value: baseUrl };
          },
          { label: "selfhost no-cimd", retryWhen: isBootReadinessTimeout },
        ),
      );

      yield* Effect.gen(function* () {
        const baseUrl = booted.value;
        // Sign into THIS scenario's instance. The identity carries no cookies
        // on purpose: browser.session pins injected cookies to the shared
        // target's baseUrl, and localhost cookies are port-blind, so a second
        // Better Auth cookie would silently replace whichever landed first.
        // One sign-in, one cookie, one origin.
        const { cookies } = yield* Effect.promise(() => signInSession(baseUrl, SELFHOST_ADMIN));
        const identity = { label: SELFHOST_ADMIN.email, credentials: SELFHOST_ADMIN };
        const displayName = `No CIMD MCP ${randomBytes(3).toString("hex")}`;

        yield* browser.session(identity, async ({ page, step }) => {
          await page.context().addCookies(cookies.map((cookie) => ({ ...cookie, url: baseUrl })));

          await step("Add an OAuth-protected MCP integration", async () => {
            const addUrl = new URL("/integrations/add/mcp", baseUrl);
            addUrl.searchParams.set("url", server.endpoint);
            await visit(page, addUrl.toString());
            await page.getByText("How does this server authenticate?").waitFor({ timeout: 30_000 });
            await page.getByPlaceholder("e.g. Linear").fill(displayName);
            await page.getByRole("button", { name: "Add integration" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            await page.getByText("Connections").first().waitFor();
          });

          await step("Connect registers a dynamic client instead of CIMD", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("heading", { name: /Add connection/ }).waitFor();

            const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
            await page.getByRole("button", { name: "Connect", exact: true }).click();
            const popup = await popupPromise;
            await popup.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });

            // The test AS login page is plain text driven by Basic-auth POST, so
            // complete it out of band and drive the popup to the callback — the
            // same journey a user's click-through consent takes.
            const callbackUrl = await submitProviderLogin(popup.url());
            await popup.goto(callbackUrl);
          });

          await step("The DCR-minted connection lands healthy", async () => {
            await page.getByLabel("Status: Healthy").waitFor({ timeout: 30_000 });
          });
        });

        const requests = yield* oauth.requests;
        expect(
          requests.filter((request) => request.method === "POST" && request.path === "/register"),
          "the flag routes the automatic connect through dynamic registration",
        ).toHaveLength(1);
        const authorize = requests.find(
          (request) => request.method === "GET" && request.path === "/authorize",
        );
        expect(authorize, "the popup reached the discovered authorization endpoint").toBeDefined();
        expect(
          authorize?.query["client_id"],
          "authorization uses the client the registration minted, not a metadata-document URL",
        ).toMatch(/^client_[0-9a-f-]+$/);
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await booted.teardown();
            rmSync(dataDir, { recursive: true, force: true });
          }),
        ),
      );
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer({ clientIdMetadataDocumentSupported: true }))),
);
