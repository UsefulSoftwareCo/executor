import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

scenario(
  "Integrations · related MCP services collapse into their declared family",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const client: Client = yield* makeClient(api, identity);
    const suffix = randomBytes(4).toString("hex");
    const family = `cloudflare-${suffix}`;
    const apiSlug = IntegrationSlug.make(`family-api-${suffix}`);
    const docsSlug = IntegrationSlug.make(`family-docs-${suffix}`);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* client.mcp.addServer({
          payload: {
            name: "Cloudflare API",
            family,
            endpoint: "https://api.example.com/mcp",
            slug: String(apiSlug),
          },
        });
        yield* client.mcp.addServer({
          payload: {
            name: "Cloudflare Docs",
            family,
            endpoint: "https://docs.example.com/mcp",
            slug: String(docsSlug),
          },
        });

        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the integrations catalog", async () => {
            await page.goto("/", { waitUntil: "networkidle" });
            await page.getByText("Integrations").first().waitFor();
          });

          await step("The related MCP services share one family card", async () => {
            const group = page.getByTestId(`integration-group-${family}`);
            await group.waitFor();
            expect(await group.innerText()).toContain("Cloudflare API");
            expect(await group.innerText()).toContain("Cloudflare Docs");
          });
        });
      }),
      Effect.gen(function* () {
        yield* client.mcp.removeServer({ params: { slug: apiSlug } }).pipe(Effect.ignore);
        yield* client.mcp.removeServer({ params: { slug: docsSlug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
