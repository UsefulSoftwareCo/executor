import { expect } from "@effect/vitest";
import { connectEmulator } from "@executor-js/emulate";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
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
import { Browser, Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "Local OAuth · reject user clients before registration while org clients connect",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const cli = yield* Cli;
      const runDir = yield* RunDir;
      const browser = yield* Browser;
      const base = yield* createEmulatorInstance("mcp", "local-ownership");
      const emulator = yield* Effect.promise(() =>
        connectEmulator({ baseUrl: base, service: "mcp" }),
      );
      yield* Effect.promise(() => emulator.seed({ users: [{ login: "local-oauth-user" }] }));
      yield* withLocalServer(cli, runDir, (server) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(api, {
            baseUrl: new URL("/api", server.origin).toString(),
            transformClient: HttpClient.mapRequest((request) =>
              HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
            ),
          }).pipe(Effect.provide(FetchHttpClient.layer));
          // The CLI fixture binds port0; pass its actual callback through the
          // public override instead of its pre-bind default port.
          const redirectUri = new URL("/api/oauth/callback", server.origin).toString();
          const endpoints = { authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token` };
          const slug = IntegrationSlug.make("local-oauth-owner");
          const registration = {
            slug: OAuthClientSlug.make("local-oauth-app"),
            issuer: base,
            registrationEndpoint: `${base}/register`,
            ...endpoints,
            resource: `${base}/mcp`,
            scopes: ["repo", "read:user"],
            tokenEndpointAuthMethodsSupported: ["none"],
            redirectUri,
            originIntegration: slug,
          };
          const rejected = yield* client.oauth
            .createClient({
              payload: {
                owner: "user",
                slug: OAuthClientSlug.make("forbidden-personal"),
                grant: "authorization_code",
                ...endpoints,
                clientId: "unused-client",
                clientSecret: "unused-secret",
              },
            })
            .pipe(Effect.flip);
          expect(rejected._tag).toBe("InternalError");
          const deniedDcr = yield* client.oauth
            .registerDynamic({ payload: { ...registration, owner: "user" } })
            .pipe(Effect.flip);
          expect(deniedDcr._tag).toBe("InternalError");
          const before = yield* Effect.promise(() => emulator.ledger.list());
          expect(before.some((entry) => entry.path === "/register")).toBe(false);
          expect((yield* client.oauth.listClients()).some((entry) => entry.owner === "user")).toBe(
            false,
          );
          yield* client.mcp.addServer({
            payload: {
              slug,
              name: "Local OAuth",
              endpoint: `${base}/mcp`,
              transport: "remote",
              authenticationTemplate: [{ kind: "oauth2" }],
            },
          });
          yield* Effect.addFinalizer(() =>
            client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore),
          );
          const registered = yield* client.oauth.registerDynamic({
            payload: { ...registration, owner: "org" },
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
              redirectUri,
            },
          });
          if (started.status !== "redirect") return yield* Effect.die("Expected OAuth redirect");
          yield* browser.session({ label: "local" }, async ({ page, step }) => {
            await step("Sign in to the local console", async () => {
              await page.goto(server.url);
              await page
                .getByTestId("integration-entry-executor")
                .first()
                .waitFor({ timeout: 30_000 });
            });
            await step("Authorize an org-owned OAuth client", async () => {
              await page.goto(started.authorizationUrl);
              await page.getByText("Authorize MCP client", { exact: true }).waitFor();
              const authorize = new URL(started.authorizationUrl);
              const approved = await page.request.post(`${base}/authorize/approve`, {
                form: { ...Object.fromEntries(authorize.searchParams), login: "local-oauth-user" },
                maxRedirects: 0,
              });
              expect(approved.status()).toBe(302);
              const callback = approved.headers().location;
              if (!callback) throw new Error("Missing OAuth callback");
              await page.goto(callback);
              await page.getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 });
            });
          });
          const catalog = yield* client.tools.list({ query: { integration: slug } });
          expect(catalog.some((entry) => entry.name === "get_me" && entry.owner === "org")).toBe(
            true,
          );
          const ledger = yield* Effect.promise(() => emulator.ledger.list());
          expect(
            ledger.some((entry) => entry.path === "/token" && entry.response.status === 200),
          ).toBe(true);
          expect(
            ledger.some(
              (entry) =>
                entry.path === "/mcp" &&
                entry.response.status === 200 &&
                entry.identity.user?.login === "local-oauth-user",
            ),
          ).toBe(true);
        }),
      );
    }),
  ),
);
