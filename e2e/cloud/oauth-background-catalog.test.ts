import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);
const decodeRpc = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

scenario(
  "OAuth · slow catalog discovery persists after the cloud callback returns",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const upstream = yield* createEmulatorInstance("mcp", "oauth-background-catalog");
      const firstListing = Promise.withResolvers<void>();
      const releaseCallbackListing = Promise.withResolvers<void>();
      const releaseOtherListings = Promise.withResolvers<void>();
      let listings = 0;

      // Only delay traffic. OAuth, credentials and MCP responses all come from
      // the published emulator. Hold later listings separately so a UI/API read
      // cannot repair the catalog and hide failure of the callback's own sync.
      const proxy = yield* serveTestHttpApp((request) =>
        Effect.promise(async () => {
          const web = await Effect.runPromise(HttpServerRequest.toWeb(request));
          const body = web.method === "GET" || web.method === "HEAD" ? undefined : await web.text();
          const path = new URL(web.url);
          const headers = new Headers(web.headers);
          headers.delete("host");
          const response = await fetch(`${upstream}${path.pathname}${path.search}`, {
            method: web.method,
            headers,
            body,
            redirect: "manual",
          });
          const rpc = body === undefined ? Option.none() : decodeRpc(body);
          if (response.ok && Option.isSome(rpc) && rpc.value.method === "tools/list") {
            listings += 1;
            if (listings === 1) {
              firstListing.resolve();
              await releaseCallbackListing.promise;
            } else {
              await releaseOtherListings.promise;
            }
          }
          return HttpServerResponse.fromWeb(response);
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releaseCallbackListing.resolve();
          releaseOtherListings.resolve();
        }),
      );

      const slug = IntegrationSlug.make(`slow_oauth_${randomBytes(4).toString("hex")}`);
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Slow OAuth catalog",
          endpoint: `${proxy.baseUrl}/mcp`,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          releaseCallbackListing.resolve();
          releaseOtherListings.resolve();
          yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
        }),
      );

      const probe = yield* client.oauth.probe({ payload: { url: `${proxy.baseUrl}/mcp` } });
      if (!probe.registrationEndpoint || !probe.authorizationUrl || !probe.tokenUrl) {
        return yield* Effect.die("Emulator did not advertise OAuth registration");
      }
      const { client: oauthClient } = yield* client.oauth.registerDynamic({
        payload: {
          owner: "org",
          slug: OAuthClientSlug.make(`${slug}_client`),
          registrationEndpoint: probe.registrationEndpoint,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: probe.scopesSupported ?? [],
          originIntegration: slug,
        },
      });
      yield* Effect.addFinalizer(() =>
        client.oauth
          .removeClient({
            params: { slug: oauthClient },
            payload: { owner: "org" },
          })
          .pipe(Effect.ignore),
      );
      const started = yield* client.oauth.start({
        payload: {
          owner: "org",
          client: oauthClient,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: slug,
          template: AuthTemplateSlug.make("oauth2"),
        },
      });
      if (started.status !== "redirect") return yield* Effect.die("Expected OAuth authorization");
      yield* Effect.addFinalizer(() =>
        client.oauth.cancel({ payload: { state: started.state } }).pipe(Effect.ignore),
      );

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Authorize the OAuth connection", async () => {
          // Stay off the integration screen until discovery is verified: its
          // refresh after the callback could otherwise repair a failed sync.
          await page.goto(started.authorizationUrl);
          const authorization = new URL(page.url());
          const approved = await page.request.post(`${upstream}/authorize/approve`, {
            form: { ...Object.fromEntries(authorization.searchParams), login: "admin" },
            maxRedirects: 0,
          });
          expect(approved.status()).toBe(302);
          const callback = approved.headers()["location"];
          if (!callback) throw new Error("Emulator did not return the OAuth callback");
          await page.goto(callback, { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "Connected" }).waitFor();
        });
        await step("Keep discovery blocked after the callback returns", async () => {
          await expect.poll(() => listings, { timeout: 15_000 }).toBeGreaterThan(0);
          await firstListing.promise;
          const connections = await Effect.runPromise(
            client.connections.list({ query: { integration: slug } }),
          );
          expect(connections).toHaveLength(1);
        });
        await step("Receive the tools from the completed background discovery", async () => {
          releaseCallbackListing.resolve();
          await expect
            .poll(
              async () => {
                const tools = await Effect.runPromise(
                  client.tools.list({ query: { integration: slug } }),
                );
                return tools.length;
              },
              { timeout: 30_000, interval: 500 },
            )
            .toBeGreaterThan(0);
          await visit(page, `/integrations/${slug}`);
          await page.getByRole("button", { name: "Add connection" }).waitFor();
        });
      });
    }),
  ),
);
