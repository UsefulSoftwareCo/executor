// Cloud-specific (browser): the onboarding MCP-setup step gives the user an
// org-scoped MCP server URL and a matching install command. Driven through the
// real web UI as a fresh user who has no organization yet.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Onboarding · the MCP setup step hands the user their org-scoped MCP server URL",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page, step }) => {
      await step(
        "A fresh user without an org lands on the create-org onboarding page",
        async () => {
          await page.goto("/", { waitUntil: "networkidle" });
          // Step 1 of 2 — the org-name input is the landmark that proves we're on onboarding.
          await page.getByPlaceholder("Northwind Labs").waitFor();
        },
      );

      await step("Create an organization to advance to the MCP setup step", async () => {
        await page.getByPlaceholder("Northwind Labs").fill("Test Org");
        await page.getByRole("button", { name: "Create organization" }).click();
        // Successful creation navigates to the 'Connect your MCP client' step.
        await page.getByText("Connect your MCP client").waitFor();
      });

      await step("Read the MCP server URL displayed on the setup page", async () => {
        const urlSection = page.getByRole("region", { name: "MCP server URL" });
        await urlSection.waitFor();
        // Wait until the endpoint is populated (the component defers origin to useEffect).
        await page.waitForFunction(() => {
          const section = document.querySelector('[aria-label="MCP server URL"]');
          const span = section?.querySelector("span.font-mono");
          return span && span.textContent !== "…" && span.textContent !== "";
        });
      });

      const mcpUrlSection = page.getByRole("region", { name: "MCP server URL" });
      const mcpUrl = await mcpUrlSection.locator("span.font-mono").innerText();
      expect(mcpUrl, "MCP URL is org-scoped").toMatch(/\/org_[^/]+\/mcp/);

      const installSection = page.getByRole("region", { name: "Install command" });
      await installSection.waitFor();
      const installCommand = await installSection.locator("code").innerText();

      // The install command must reference the SAME org as the displayed URL
      // — not a different one or a bare /mcp path.
      const orgId = /\/(org_[^/]+)\/mcp/.exec(mcpUrl)?.[1] ?? "(no org segment in MCP URL)";
      expect(installCommand, "the install command references the same org").toContain(orgId);
    });
  }),
);
