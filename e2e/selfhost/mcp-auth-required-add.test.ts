// Regression guard for the add-MCP dead-end on a server that gates on auth
// without a spec-compliant MCP challenge: the user should reach the auth-method
// editor, not a "requires authentication, add credentials below" error with no
// editor rendered below it.
//
// Selfhost-only because the probe must shape-probe a loopback server: the
// selfhost instance runs with EXECUTOR_ALLOW_LOCAL_NETWORK so its outbound
// probe can reach the loopback test server. Video is the artifact.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "Auth methods · a non-spec-compliant 401 still gets the auth editor (no dead-end)",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      // Auth-gated shape: a 401 with no Bearer WWW-Authenticate, no RFC 9728
      // protected-resource metadata (the .well-known probe 404s), and a body
      // that is neither JSON-RPC nor an OAuth error envelope.
      const server = yield* serveTestHttpApp((request) =>
        Effect.succeed(
          (request.url ?? "").includes("/.well-known/")
            ? HttpServerResponse.text("missing", { status: 404 })
            : HttpServerResponse.jsonUnsafe({ message: "Unauthorized" }, { status: 401 }),
        ),
      );
      const endpoint = server.url("/mcp");
      // The raw 401 server reports no server name, so the probe can't seed a
      // unique identity. Selfhost identities share one tenant, so name the
      // integration uniquely to keep the derived slug from colliding across
      // runs.
      const name = `auth-gated-401-${randomBytes(3).toString("hex")}`;
      const slug = IntegrationSlug.make(deriveMcpNamespace({ name }));
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at the auth-gated server", async () => {
            await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(endpoint)}`, {
              waitUntil: "networkidle",
            });
            // Before the fix this dead-ended on a red "add credentials below"
            // error with no editor. Now the auth-method editor renders.
            await page.getByText("How does this server authenticate?").waitFor();
          });

          await step("The probe seeded a detected Bearer-header method", async () => {
            await page.getByText("Method 1 · Detected").waitFor();
            // The preview card flags the gate rather than failing the probe.
            await page.getByText("Auth required").first().waitFor();
          });

          await step("Add the source with the declared method", async () => {
            await page.getByPlaceholder("e.g. Linear").fill(name);
            await page.getByRole("button", { name: "Add source" }).click();
            // onComplete routes to the new integration's detail hub.
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            const landedSlug = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
            expect(landedSlug, "the add flow lands on the created integration").toBe(String(slug));
            await page.getByText("Connections").first().waitFor();
          });

          await step("The declared API key method is connectable", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
          });
        });
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore)));
    }),
  ),
);
