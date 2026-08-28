import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { clickToReveal, visit } from "../src/surfaces/browser";

// The connect dialog's long-tail search goes to the public integrations.sh
// registry from the browser. CI must not depend on the live service, so both
// registry endpoints are fulfilled at the network layer here — including the
// CORS header a real cross-origin browser call needs.
scenario(
  "Connect dialog: integrations.sh catalog search resolves into a prefilled add flow",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Stub the integrations.sh registry endpoints", async () => {
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
                  url: "https://integrations.sh/todoist.com/",
                },
              ],
            },
          }),
        );
        await page.route("https://integrations.sh/api/todoist.com/surface", (route) =>
          route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            json: {
              version: 3,
              domain: "todoist.com",
              surfaces: [
                { type: "mcp", url: "https://ai.todoist.net/mcp", slug: "todoist" },
                { type: "cli", slug: "todoist-cli" },
              ],
            },
          }),
        );
      });

      await step("Searching surfaces the catalog row under the presets", async () => {
        await visit(page, "/integrations");
        const dialog = page.getByRole("dialog", { name: "Connect an integration" });
        await clickToReveal(page.getByRole("button", { name: "Connect" }), dialog);
        await dialog.getByPlaceholder(/Search or paste a URL/).fill("todoist");
        // The CLI-only surface is not offered; the connectable kind is.
        await dialog
          .getByRole("button", { name: /todoist\.com/ })
          .getByText("MCP")
          .waitFor();
      });

      await step("Picking the row lands on the MCP add flow, prefilled", async () => {
        const dialog = page.getByRole("dialog", { name: "Connect an integration" });
        await dialog.getByRole("button", { name: /todoist\.com/ }).click();
        await page.waitForURL(/\/integrations\/add\/mcp/);
        const url = new URL(page.url());
        expect(url.searchParams.get("url")).toBe("https://ai.todoist.net/mcp");
        expect(url.searchParams.get("namespace")).toBe("todoist");
      });
    });
  }),
);
