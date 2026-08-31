// Regression guard for adding a remote MCP server that sits behind an edge
// authenticator. Cloudflare Access answers an unauthenticated request with a
// `403` HTML sign-in page, so the MCP server itself is never reached: no
// Bearer challenge, no RFC 9728 metadata, no JSON-RPC body. That used to read
// as "Couldn't reach this URL", which is wrong and offered no way forward.
//
// Now the 403 classifies as auth-required, and the add flow carries a request
// headers editor whose values ride along on the connection check. Both halves
// are asserted here: the flow reaches the auth editor, and the service-token
// headers actually reach the server.
//
// Selfhost-only because the probe must reach a loopback server: the selfhost
// instance runs with EXECUTOR_ALLOW_LOCAL_NETWORK. Video is the artifact.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([mcpHttpPlugin()] as const);

const CLIENT_ID_HEADER = "CF-Access-Client-Id";
const CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";
const CLIENT_ID = "e2e-service-token-id";
const CLIENT_SECRET = "e2e-service-token-secret";

scenario(
  "MCP headers · a 403 edge gate is addable with service-token headers",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;

      // Cloudflare Access shape: every request is answered with a 403 HTML
      // sign-in page. The headers each request carried are recorded so the
      // scenario can prove the connection check sent the configured pair.
      const seen = yield* Ref.make<readonly Readonly<Record<string, string>>[]>([]);
      const server = yield* serveTestHttpApp((request) =>
        Effect.gen(function* () {
          yield* Ref.update(seen, (all) => [...all, request.headers]);
          if ((request.url ?? "").includes("/.well-known/")) {
            return HttpServerResponse.text("missing", { status: 404 });
          }
          return HttpServerResponse.text("<html><body>Sign in</body></html>", {
            status: 403,
            contentType: "text/html",
          });
        }),
      );

      const endpoint = server.url("/mcp");
      // The gate reports no server name, so the probe cannot seed a unique
      // identity. Selfhost identities share one tenant, so name the
      // integration uniquely to keep the derived slug stable across runs.
      const name = `edge-gated-403-${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name }));
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at the 403-gated server", async () => {
            await visit(page, `/integrations/add/mcp?url=${encodeURIComponent(endpoint)}`);
            // Before the fix the 403 read as unreachable and the flow stopped
            // on "Couldn't reach this URL". Now it continues.
            await page.getByText("How does this server authenticate?").waitFor();
            await page.getByText("Auth required").first().waitFor();
          });

          await step("Configure the Cloudflare Access service-token headers", async () => {
            await page.getByRole("button", { name: "Add header" }).click();
            await page.getByLabel("Header name").nth(0).fill(CLIENT_ID_HEADER);
            await page.getByLabel("Header value").nth(0).fill(CLIENT_ID);
            await page.getByRole("button", { name: "Add header" }).click();
            await page.getByLabel("Header name").nth(1).fill(CLIENT_SECRET_HEADER);
            await page.getByLabel("Header value").nth(1).fill(CLIENT_SECRET);
          });

          await step("Test connection sends the headers to the server", async () => {
            await page.getByRole("button", { name: "Test connection" }).click();
            // The button reports the in-flight probe with `data-loading`.
            // Wait for it to clear so the re-probe has landed before we add.
            await page.locator("button[data-loading]").waitFor({ state: "detached" });
            await page.getByText("Auth required").first().waitFor();
          });

          await step("Add the integration", async () => {
            await page.getByPlaceholder("e.g. Linear").fill(name);
            await page.getByRole("button", { name: "Add integration" }).click();
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            const landedSlug = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
            expect(landedSlug, "the add flow lands on the created integration").toBe(String(slug));
          });
        });

        const requests = yield* Ref.get(seen);
        const authenticated = requests.filter(
          (headers) => headers[CLIENT_ID_HEADER.toLowerCase()] === CLIENT_ID,
        );
        expect(
          authenticated.length,
          "the connection check reaches the server with the configured headers",
        ).toBeGreaterThan(0);
        expect(
          authenticated.some(
            (headers) => headers[CLIENT_SECRET_HEADER.toLowerCase()] === CLIENT_SECRET,
          ),
          "both halves of the service token are sent together",
        ).toBe(true);

        const stored = yield* client.mcp.getServer({ params: { slug } });
        expect(stored?.config, "the headers persist on the integration").toMatchObject({
          transport: "remote",
          headers: {
            [CLIENT_ID_HEADER]: CLIENT_ID,
            [CLIENT_SECRET_HEADER]: CLIENT_SECRET,
          },
        });
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore)));
    }),
  ),
);
