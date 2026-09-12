import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { connectEmulator } from "@executor-js/emulate";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

scenario(
  "OAuth optional scopes · the integration partitions scopes and completes an authenticated connection",
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
      expect((yield* session.call("execute", { code: "return true;" })).ok).toBe(true);
      const base = yield* createEmulatorInstance("github", "optional-scopes");
      const emulator = yield* Effect.promise(() =>
        connectEmulator({ baseUrl: base, service: "github" }),
      );
      yield* Effect.promise(() => emulator.seed({ users: [{ login: "optional-scope-user" }] }));
      const slug = IntegrationSlug.make(`optional-${randomBytes(4).toString("hex")}`);
      const app = OAuthClientSlug.make(`${slug}-app`);
      yield* Effect.addFinalizer(() =>
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer(() =>
        client.oauth
          .removeClient({ params: { slug: app }, payload: { owner: "org" } })
          .pipe(Effect.orDie),
      );
      // GitHub supplies the real OAuth transport and protected resource. The test
      // verifies Executor's partitioning contract; it does not claim that GitHub
      // implements HubSpot's optional-grant policy.
      const authorizationUrl = `${base}/login/oauth/authorize`;
      const tokenUrl = `${base}/login/oauth/access_token`;
      yield* client.openapi.addSpec({
        payload: {
          slug,
          baseUrl: base,
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "Optional scope API", version: "1" },
              paths: {
                "/user": {
                  get: {
                    operationId: "getUser",
                    security: [{ oauth: ["read:user"] }],
                    responses: { "200": { description: "Authenticated user" } },
                  },
                },
              },
              components: {
                securitySchemes: {
                  oauth: {
                    type: "oauth2",
                    flows: {
                      authorizationCode: {
                        authorizationUrl,
                        tokenUrl,
                        scopes: {
                          "read:user": "Read user",
                          "user:email": "Read email when granted",
                        },
                      },
                    },
                  },
                },
              },
            }),
          },
          authenticationTemplate: [
            {
              slug: "oauth",
              kind: "oauth2",
              authorizationUrl: `${authorizationUrl}?optional_scope=user%3Aemail`,
              tokenUrl,
              scopes: ["read:user", "user:email"],
            },
          ],
        },
      });
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: app,
          grant: "authorization_code",
          authorizationUrl,
          tokenUrl,
          clientId: "optional-test-client",
          clientSecret: "optional-test-secret",
          originIntegration: slug,
        },
      });
      const started = yield* client.oauth.start({
        payload: {
          owner: "org",
          client: app,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: slug,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      if (started.status !== "redirect")
        return yield* Effect.die("Expected authorization redirect");

      yield* Effect.addFinalizer(() =>
        client.oauth.cancel({ payload: { state: started.state } }).pipe(Effect.orDie),
      );
      const url = new URL(started.authorizationUrl);
      expect(url.searchParams.get("scope")).toBe("read:user");
      expect(url.searchParams.get("optional_scope")).toBe("user:email");
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Review and approve the OAuth consent request", async () => {
          await page.goto(started.authorizationUrl);
          await page.getByRole("button", { name: /optional-scope-user/ }).click();
          await page.getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 });
        });
      });
      yield* Effect.addFinalizer(() =>
        client.connections
          .remove({
            params: { owner: "org", integration: slug, name: ConnectionName.make("main") },
          })
          .pipe(Effect.orDie),
      );
      const catalog = yield* client.tools.list({ query: { integration: slug } });
      const tool = catalog.find((entry) => entry.name.endsWith("getUser"));
      if (!tool)
        return yield* Effect.die(
          `Authenticated getUser tool missing: ${catalog.map((entry) => entry.name).join(", ")}`,
        );
      let result = yield* session.call("execute", {
        code: `const path = ${JSON.stringify(String(tool.address))}.split(".").slice(1); let call = tools; for (const part of path) call = call[part]; return await call({});`,
      });
      for (let attempts = 0; result.text.includes("executionId:") && attempts < 10; attempts += 1)
        result = yield* session.approvePaused(result.text);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("optional-scope-user");
      const ledger = yield* Effect.promise(() => emulator.ledger.list());
      const authorize = ledger.find(
        (entry) => entry.method === "GET" && entry.path.endsWith("/login/oauth/authorize"),
      );
      expect(new URLSearchParams(authorize?.query).get("optional_scope")).toBe("user:email");
      expect(
        ledger
          .filter((entry) => entry.path === "/user" && entry.response.status === 200)
          .map((entry) => entry.identity.user?.login),
      ).toContain("optional-scope-user");
    }),
  ),
);
