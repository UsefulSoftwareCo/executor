import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

// The picker's registry search goes to the public integrations.sh service from
// the browser. CI must not depend on the live service, so the search endpoint
// is fulfilled at the network layer here — including the CORS header a real
// cross-origin browser call needs. The MCP endpoints themselves are NOT
// stubbed: the quick add probes and registers server-side, so the working row
// points at a local fixture server and the broken row at a reserved-TLD host.
scenario(
  "Add page: a registry row adds in place, and falls back to the config screen",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    // Unique per run — the derived namespace must not collide on targets
    // whose identities share one tenant (selfhost admin).
    const suffix = randomBytes(3).toString("hex");
    const server = yield* serveMcpServer(() =>
      makeGreetingMcpServer({ name: `catalog-quick-${suffix}` }),
    );
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Stub the integrations.sh search endpoint", async () => {
        await page.route("https://integrations.sh/api/search*", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              results: [
                {
                  domain: "todoist.com",
                  name: "todoist.com",
                  description: "Tasks, projects, and collaboration.",
                  kinds: ["mcp", "cli"],
                  surfaces: [
                    { kind: "mcp", slug: `todoist-${suffix}`, url: server.endpoint },
                    { kind: "cli", slug: "todoist-cli" },
                  ],
                },
                {
                  domain: "deadserver.com",
                  name: "deadserver.com",
                  description: "A vendor whose MCP endpoint is gone.",
                  kinds: ["mcp"],
                  surfaces: [
                    { kind: "mcp", slug: "deadserver", url: "https://mcp.notareal.invalid/mcp" },
                  ],
                },
              ],
            },
          }),
        );
      });

      await step("Searching surfaces the connectable rows, not the CLI", async () => {
        await visit(page, "/integrations/browse");
        await page.getByPlaceholder(/Search integrations, or paste a URL/).fill("todoist");
        await page.getByTestId(`catalog-todoist-${suffix}`).getByText("Todoist MCP").waitFor();
        await page.getByTestId("catalog-deadserver").waitFor();
        expect(await page.getByTestId("catalog-todoist-cli").count()).toBe(0);
      });

      await step("Add registers in place; the card flips to View", async () => {
        await page
          .getByTestId(`catalog-todoist-${suffix}`)
          .getByRole("button", { name: "Add Todoist MCP" })
          .click();
        // Generous timeout: the quick add probes the fixture server and
        // registers, all behind one click, and the dev server can queue
        // under CI load.
        await page
          .getByTestId(`catalog-todoist-${suffix}`)
          .getByRole("link", { name: "View Todoist MCP" })
          .waitFor({ timeout: 90_000 });
        // The whole point: the user never left the picker.
        expect(new URL(page.url()).pathname).toMatch(/\/integrations\/browse$/);
      });

      await step("View jumps to the integration's hub", async () => {
        await page
          .getByTestId(`catalog-todoist-${suffix}`)
          .getByRole("link", { name: "View Todoist MCP" })
          .click();
        await page.waitForURL(new RegExp(`/integrations/todoist_${suffix}`));
        await page.goBack();
        await page.getByPlaceholder(/Search integrations, or paste a URL/).fill("todoist");
        await page.getByTestId("catalog-deadserver").waitFor();
      });

      await step("An unreachable endpoint falls back to the config screen", async () => {
        await page
          .getByTestId("catalog-deadserver")
          .getByRole("button", { name: "Add Deadserver MCP" })
          .click();
        // Quick add cannot register it, so the click lands on the add flow
        // prefilled with the same facts — where the probe failure renders
        // with retry UX.
        await page.waitForURL(/\/integrations\/add\/mcp/, { timeout: 90_000 });
        const url = new URL(page.url());
        expect(url.searchParams.get("url")).toBe("https://mcp.notareal.invalid/mcp");
        expect(url.searchParams.get("namespace")).toBe("deadserver");
      });
    });
  }),
);
