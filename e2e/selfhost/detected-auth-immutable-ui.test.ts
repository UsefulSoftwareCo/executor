// Selfhost-only (browser): a spec/probe-DETECTED auth method is immutable in
// the add flow. The shared AuthMethodListEditor renders detected methods as a
// disabled, read-only summary ("Pulled from spec. Remove to override.") with no
// kind selector, so a user can't silently retype the spec's method into a kind
// nothing backs. A method the user adds by hand stays fully editable. Both the
// MCP and OpenAPI add flows compose the same editor, so one behavior, two
// surfaces. Selfhost runs with EXECUTOR_ALLOW_LOCAL_NETWORK so the probe/analyze
// can reach the loopback fixtures. Video is the artifact.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeGreetingMcpServer, serveMcpServerWithOAuth } from "@executor-js/plugin-mcp/testing";
import { OAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const REMOVE_HINT = "Pulled from spec. Remove to override.";

scenario(
  "Detected auth · an MCP probe's OAuth method is immutable in the add flow",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      // OAuth-protected server: the probe 401s with resource metadata, so the
      // method list seeds a single detected OAuth row (discovered metadata).
      const server = yield* serveMcpServerWithOAuth(
        () => makeGreetingMcpServer({ name: `oauth-mcp-${randomBytes(3).toString("hex")}` }),
        { path: "/mcp" },
      );
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the add-MCP flow pointed at the OAuth server", async () => {
          await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`, {
            waitUntil: "networkidle",
          });
          await page.getByText("How does this server authenticate?").waitFor();
          await page.getByText("Method 1 · Detected").waitFor();
        });

        await step("The detected method is locked: read-only, named, no selector", async () => {
          // The kind is named explicitly ("OAuth"), the discovered-OAuth summary
          // and override hint sit inside a disabled block, and there is NO
          // editable kind selector (the FilterTabs render as buttons).
          await page.getByText("OAuth", { exact: true }).first().waitFor();
          await page.getByText("OAuth metadata is discovered from this server").waitFor();
          await page.getByText(REMOVE_HINT).waitFor();
          expect(
            await page.locator("[aria-disabled]").count(),
            "the detected method renders a disabled (non-interactive) block",
          ).toBeGreaterThan(0);
          expect(
            await page.getByRole("button", { name: "API key", exact: true }).count(),
            "no editable kind selector is shown for the detected method",
          ).toBe(0);
        });

        await step("A hand-added method keeps the full editable selector", async () => {
          await page.getByRole("button", { name: "Add method" }).click();
          await page.getByText("Method 2").waitFor();
          // The added row defaults to API key and exposes the None/API key/OAuth
          // kind tabs (buttons) — the detected row above still shows none.
          expect(
            await page.getByRole("button", { name: "API key", exact: true }).count(),
            "the added method exposes the kind selector",
          ).toBeGreaterThan(0);
          await page.getByText(REMOVE_HINT).waitFor();
        });
      });
    }),
  ).pipe(Effect.provide(OAuthTestServer.layer())),
);

/** A real 127.0.0.1 server that serves a static OpenAPI spec for the add flow. */
const serveSpec = (body: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/spec.json`,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const apiKeyAndOAuthSpec = (): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Acme Immutable Auth Fixture", version: "1.0.0" },
    servers: [{ url: "https://api.acme.test" }],
    security: [{ bearerAuth: [] }, { acmeOAuth: ["read"] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        acmeOAuth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://api.acme.test/oauth/authorize",
              tokenUrl: "https://api.acme.test/oauth/token",
              scopes: { read: "Read access" },
            },
          },
        },
      },
    },
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          summary: "List widgets",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

scenario(
  "Detected auth · OpenAPI spec-detected methods are immutable in the add flow",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const spec = yield* serveSpec(apiKeyAndOAuthSpec());
      const identity = yield* target.newIdentity();

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Analyze a spec that declares both API key and OAuth", async () => {
          await page.goto(`/integrations/add/openapi`, { waitUntil: "networkidle" });
          await page
            .getByPlaceholder(/openapi\.json/i)
            .first()
            .fill(spec.url);
          await page.getByText("How does this API authenticate?").waitFor();
          await page.getByText("Method 2").waitFor();
        });

        await step("Both detected methods are locked, named, read-only", async () => {
          // Two detected methods, each with the override hint and its kind named
          // ("API key" / "OAuth"); the OAuth one shows the spec's real endpoints
          // read-only. No editable kind selector (FilterTabs render as buttons).
          expect(
            await page.getByText(REMOVE_HINT).count(),
            "both detected methods show the remove-to-override hint",
          ).toBe(2);
          await page.getByText("https://api.acme.test/oauth/authorize").waitFor();
          await page.getByText("API key", { exact: true }).first().waitFor();
          await page.getByText("OAuth", { exact: true }).first().waitFor();
          expect(
            await page.getByRole("button", { name: "OAuth", exact: true }).count(),
            "no editable kind selector is shown for the detected methods",
          ).toBe(0);
        });

        await step("A hand-added method keeps the full editable selector", async () => {
          await page.getByRole("button", { name: "Add method" }).click();
          await page.getByText("Method 3").waitFor();
          expect(
            await page.getByRole("button", { name: "API key", exact: true }).count(),
            "the added method exposes the kind selector",
          ).toBeGreaterThan(0);
        });
      });
    }),
  ),
);
