import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { connectEmulator } from "@executor-js/emulate";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "Vercel OAuth · lifecycle scopes survive registration and a complete MCP connection",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const session = mcp.session(identity);
      // Authenticate the host MCP transport before minting upstream credentials.
      // The hosted emulator currently loses its OAuth token map on eviction.
      const ready = yield* session.call("execute", { code: "return true;" });
      expect(ready.ok).toBe(true);
      const base = yield* createEmulatorInstance("mcp", "vercel-lifecycle");
      const emulator = yield* Effect.promise(() =>
        connectEmulator({ baseUrl: base, service: "mcp" }),
      );
      yield* Effect.promise(() =>
        emulator.seed({ users: [{ login: "lifecycle-user" }], scopes: ["openid"] }),
      );
      const slug = IntegrationSlug.make(`lifecycle-${randomBytes(4).toString("hex")}`);
      const app = OAuthClientSlug.make(`${slug}-app`);
      yield* Effect.addFinalizer(() =>
        client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
      );
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Lifecycle MCP",
          endpoint: `${base}/mcp`,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      const registered = yield* client.oauth.registerDynamic({
        payload: {
          owner: "org",
          slug: app,
          issuer: base,
          registrationEndpoint: `${base}/register`,
          authorizationUrl: "https://vercel.com/oauth/authorize",
          tokenUrl: `${base}/token`,
          resource: `${base}/mcp`,
          scopes: ["openid"],
          tokenEndpointAuthMethodsSupported: ["none"],
          originIntegration: slug,
        },
      });
      yield* Effect.addFinalizer(() =>
        client.oauth
          .removeClient({ params: { slug: registered.client }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      );
      const started = yield* client.oauth.start({
        payload: {
          owner: "org",
          client: registered.client,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: slug,
          template: AuthTemplateSlug.make("oauth2"),
        },
      });
      if (started.status !== "redirect")
        return yield* Effect.die("Expected authorization redirect");
      yield* Effect.addFinalizer(() =>
        client.oauth.cancel({ payload: { state: started.state } }).pipe(Effect.ignore),
      );
      const authorize = new URL(started.authorizationUrl);
      expect(authorize.origin + authorize.pathname).toBe("https://vercel.com/oauth/authorize");
      expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(["openid", "offline_access"]);
      // Route only the provider transport to the published emulator. The product
      // produced all OAuth parameters; DCR, PKCE, consent, callback and MCP are real.
      // This fixture does not claim to prove Vercel's refresh-token issuance policy.
      const consentUrl = `${base}/authorize${authorize.search}`;
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Review the provider consent request", async () => {
          await page.goto(consentUrl);
          await page.getByText("Authorize MCP client", { exact: true }).waitFor();
        });
        await step("Approve the requested access and complete the callback", async () => {
          const form = Object.fromEntries(authorize.searchParams);
          const approved = await page.request.post(`${base}/authorize/approve`, {
            form: { ...form, login: "lifecycle-user" },
            maxRedirects: 0,
          });
          expect(approved.status()).toBe(302);
          const callback = approved.headers().location;
          expect(callback).toBeDefined();
          await page.goto(callback!);
          await page
            .getByText(/connected|complete|success/i)
            .first()
            .waitFor({ timeout: 30_000 });
        });
      });
      const tools = yield* client.tools.list({ query: { integration: slug } });
      const tool = tools.find((entry) => entry.name === "get_me");
      expect(tool).toBeDefined();
      if (!tool) return yield* Effect.die("Connected MCP has no get_me tool");
      let result = yield* session.call("execute", {
        code: `const path = ${JSON.stringify(String(tool.address))}.split(".").slice(1); let call = tools; for (const part of path) call = call[part]; return await call({});`,
      });
      for (let attempts = 0; result.text.includes("executionId:") && attempts < 10; attempts += 1)
        result = yield* session.approvePaused(result.text);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("lifecycle-user");
      const ledger = yield* Effect.promise(() => emulator.ledger.list());
      const registration = ledger.find(
        (entry) => entry.method === "POST" && entry.path.endsWith("/register"),
      );
      expect(registration?.request.body).toMatchObject({ scope: "openid offline_access" });
      expect(
        ledger.some(
          (entry) =>
            entry.method === "POST" &&
            entry.path.endsWith("/token") &&
            entry.response.status === 200,
        ),
      ).toBe(true);
    }),
  ),
);
